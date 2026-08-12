use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const VERSION: &str = "1.0.0";

struct BrowserSlot {
    id: u64,
    child: Child,
    ws_url: String,
    profile: PathBuf,
    leased: bool,
}

impl BrowserSlot {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.profile);
    }
}

struct Pool {
    chrome: PathBuf,
    slots: Vec<BrowserSlot>,
    next_id: u64,
    last_activity: Instant,
}

impl Pool {
    fn acquire(&mut self, count: usize) -> Result<Vec<(u64, String)>, String> {
        self.last_activity = Instant::now();
        for slot in &mut self.slots {
            if !slot.leased && !slot.alive() {
                slot.stop();
            }
        }
        self.slots.retain_mut(|slot| slot.leased || slot.alive());

        let available = self.slots.iter().filter(|slot| !slot.leased).count();
        let mut launches = Vec::new();
        for _ in available..count {
            let id = self.next_id;
            self.next_id += 1;
            let chrome = self.chrome.clone();
            launches.push(thread::spawn(move || launch_chrome(&chrome, id)));
        }
        let mut launched = Vec::with_capacity(launches.len());
        let mut launch_error = None;
        for handle in launches {
            match handle.join() {
                Ok(Ok(slot)) => launched.push(slot),
                Ok(Err(error)) => launch_error = Some(error),
                Err(_) => launch_error = Some("Chrome launch thread panicked".into()),
            }
        }
        if let Some(error) = launch_error {
            for slot in &mut launched {
                slot.stop();
            }
            return Err(error);
        }
        self.slots.extend(launched);

        let mut leases = Vec::with_capacity(count);
        for slot in &mut self.slots {
            if !slot.leased && leases.len() < count {
                slot.leased = true;
                leases.push((slot.id, slot.ws_url.clone()));
            }
        }
        Ok(leases)
    }

    fn release(&mut self, ids: &[u64]) {
        self.last_activity = Instant::now();
        for slot in &mut self.slots {
            if ids.contains(&slot.id) {
                slot.leased = false;
            }
        }
    }

    fn has_leases(&self) -> bool {
        self.slots.iter().any(|slot| slot.leased)
    }

    fn shutdown(&mut self) {
        for slot in &mut self.slots {
            slot.stop();
        }
        self.slots.clear();
    }
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let result = if args.get(1).map(String::as_str) == Some("fingerprint") {
        run_fingerprint(&args[2..])
    } else {
        run()
    };
    if let Err(error) = result {
        eprintln!("ryzerd: {error}");
        std::process::exit(1);
    }
}

fn run_fingerprint(args: &[String]) -> Result<(), String> {
    let mut root: Option<PathBuf> = None;
    let mut excludes = vec![PathBuf::from(".git"), PathBuf::from("node_modules")];
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" => {
                index += 1;
                root = args.get(index).map(PathBuf::from);
            }
            "--exclude" => {
                index += 1;
                excludes.push(PathBuf::from(
                    args.get(index).ok_or("--exclude needs a value")?,
                ));
            }
            value => return Err(format!("unknown fingerprint argument: {value}")),
        }
        index += 1;
    }
    let root = root.ok_or("fingerprint requires --root")?;
    let root = fs::canonicalize(&root).map_err(|error| format!("fingerprint root: {error}"))?;
    let mut pending = Vec::new();
    fingerprint_directory(&root, &root, &excludes, &mut pending)?;
    let mut entries = hash_entries(pending)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for (path, size, modified, hash) in entries {
        writeln!(
            output,
            "{}\t{size}\t{modified}\t{hash}",
            escape_field(&path)
        )
        .map_err(|error| format!("write fingerprint: {error}"))?;
    }
    Ok(())
}

/// A walked entry whose content has not been hashed yet. Hashing is the only
/// expensive part and it is embarrassingly parallel, so the walk records what
/// to hash and `hash_entries` fans the work across the available cores.
struct PendingEntry {
    relative: String,
    path: PathBuf,
    size: u64,
    modified: u128,
    symlink_target: Option<PathBuf>,
}

type FingerprintRow = (String, u64, u128, String);
type HashedSlot = Mutex<Option<Result<FingerprintRow, String>>>;

fn hash_entries(pending: Vec<PendingEntry>) -> Result<Vec<FingerprintRow>, String> {
    let threads = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(pending.len().max(1));
    if threads <= 1 {
        return pending.iter().map(hash_one_ref).collect();
    }
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<HashedSlot> = pending.iter().map(|_| Mutex::new(None)).collect();
    thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(entry) = pending.get(index) else {
                    return;
                };
                let hashed = hash_one_ref(entry);
                if let Ok(mut slot) = results[index].lock() {
                    *slot = Some(hashed);
                }
            });
        }
    });
    results
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .map_err(|_| "fingerprint result lock poisoned".to_string())?
                .ok_or_else(|| "fingerprint worker produced no result".to_string())?
        })
        .collect()
}

fn hash_one_ref(entry: &PendingEntry) -> Result<FingerprintRow, String> {
    let hash = match &entry.symlink_target {
        Some(target) => hash_symlink(&entry.path, target)?,
        None => hash_file(&entry.path)?,
    };
    Ok((entry.relative.clone(), entry.size, entry.modified, hash))
}

fn fingerprint_directory(
    root: &Path,
    directory: &Path,
    excludes: &[PathBuf],
    entries: &mut Vec<PendingEntry>,
) -> Result<(), String> {
    let children = fs::read_dir(directory)
        .map_err(|error| format!("read directory {}: {error}", directory.display()))?;
    for child in children {
        let child = child.map_err(|error| format!("read directory entry: {error}"))?;
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("relative path: {error}"))?;
        if excludes
            .iter()
            .any(|exclude| relative == exclude || relative.starts_with(exclude))
        {
            continue;
        }
        let file_type = child
            .file_type()
            .map_err(|error| format!("file type {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            let target = fs::read_link(&path)
                .map_err(|error| format!("read symlink {}: {error}", path.display()))?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("symlink metadata {}: {error}", path.display()))?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            entries.push(PendingEntry {
                relative: relative.to_string_lossy().replace('\\', "/"),
                size: metadata.len(),
                modified,
                path,
                symlink_target: Some(target),
            });
            continue;
        }
        if file_type.is_dir() {
            fingerprint_directory(root, &path, excludes, entries)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = child
            .metadata()
            .map_err(|error| format!("metadata {}: {error}", path.display()))?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        entries.push(PendingEntry {
            relative: relative.to_string_lossy().replace('\\', "/"),
            size: metadata.len(),
            modified,
            path,
            symlink_target: None,
        });
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(digest_hex(hash.finish()))
}

fn hash_symlink(path: &Path, target: &Path) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(b"symlink\0");
    hash.update(target.to_string_lossy().as_bytes());
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        hash.update(b"\0file\0");
        let mut file =
            fs::File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("read {}: {error}", path.display()))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    }
    Ok(digest_hex(hash.finish()))
}

fn digest_hex(digest: [u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    block_len: usize,
    length: u64,
}

impl Sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: [0; 64],
            block_len: 0,
            length: 0,
        }
    }

    fn update(&mut self, mut bytes: &[u8]) {
        self.length = self.length.wrapping_add(bytes.len() as u64);
        if self.block_len > 0 {
            let count = (64 - self.block_len).min(bytes.len());
            self.block[self.block_len..self.block_len + count].copy_from_slice(&bytes[..count]);
            self.block_len += count;
            bytes = &bytes[count..];
            if self.block_len == 64 {
                let block = self.block;
                self.compress(&block);
                self.block_len = 0;
            }
        }
        while bytes.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&bytes[..64]);
            self.compress(&block);
            bytes = &bytes[64..];
        }
        // Only overwrite the buffer when there is something left to buffer. An
        // unconditional store discards bytes that the partial-block branch
        // above just accumulated, which silently reduced every multi-update
        // digest to a function of its length alone.
        if !bytes.is_empty() {
            self.block[..bytes.len()].copy_from_slice(bytes);
            self.block_len = bytes.len();
        }
    }

    fn finish(mut self) -> [u8; 32] {
        let bit_length = self.length.wrapping_mul(8);
        self.block[self.block_len] = 0x80;
        self.block_len += 1;
        if self.block_len > 56 {
            self.block[self.block_len..].fill(0);
            let block = self.block;
            self.compress(&block);
            self.block = [0; 64];
        } else {
            self.block[self.block_len..56].fill(0);
        }
        self.block[56..].copy_from_slice(&bit_length.to_be_bytes());
        let block = self.block;
        self.compress(&block);
        let mut output = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        output
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut words = [0u32; 64];
        for (index, bytes) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes(bytes.try_into().expect("four-byte SHA-256 word"));
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for (index, word) in words.iter().enumerate() {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temporary1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(Self::K[index])
                .wrapping_add(*word);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temporary2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temporary1);
            d = c;
            c = b;
            b = a;
            a = temporary1.wrapping_add(temporary2);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
}

fn escape_field(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\t', "%09")
        .replace('\r', "%0d")
        .replace('\n', "%0a")
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut socket_path: Option<PathBuf> = None;
    let mut chrome_path: Option<PathBuf> = None;
    // A daemon that exits during a coffee break costs the next run a full cold
    // Chrome launch per worker, measured at roughly 250ms for one slot and
    // 490ms for four. The parked processes are the same ones the previous run
    // already held, so a longer window changes how long they persist, not peak
    // memory. Override with --idle-seconds or RYZER_DAEMON_IDLE_SECONDS.
    let mut idle_seconds = 3_600u64;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next().map(PathBuf::from),
            "--chrome" => chrome_path = args.next().map(PathBuf::from),
            "--idle-seconds" => {
                idle_seconds = args
                    .next()
                    .ok_or("--idle-seconds needs a value")?
                    .parse()
                    .map_err(|_| "invalid --idle-seconds")?;
            }
            "--version" => {
                println!("{VERSION}");
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    let socket_path = socket_path.ok_or("missing --socket")?;
    let chrome_path = chrome_path.ok_or("missing --chrome")?;
    if !chrome_path.exists() {
        return Err(format!(
            "Chrome executable does not exist: {}",
            chrome_path.display()
        ));
    }

    if socket_path.exists() {
        if UnixStream::connect(&socket_path).is_ok() {
            return Err(format!(
                "daemon already running at {}",
                socket_path.display()
            ));
        }
        fs::remove_file(&socket_path).map_err(|error| format!("remove stale socket: {error}"))?;
    }
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create socket directory: {error}"))?;
    }
    let listener =
        UnixListener::bind(&socket_path).map_err(|error| format!("bind socket: {error}"))?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("secure socket: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking: {error}"))?;

    let pool = Arc::new(Mutex::new(Pool {
        chrome: chrome_path,
        slots: Vec::new(),
        next_id: 1,
        last_activity: Instant::now(),
    }));

    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let pool = Arc::clone(&pool);
                if let Ok(mut value) = pool.lock() {
                    value.last_activity = Instant::now();
                }
                thread::spawn(move || handle_client(stream, pool));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("accept connection: {error}")),
        }

        thread::sleep(Duration::from_millis(25));
        let should_exit = {
            let pool = pool.lock().map_err(|_| "pool lock poisoned")?;
            !pool.has_leases() && pool.last_activity.elapsed() >= Duration::from_secs(idle_seconds)
        };
        if should_exit {
            break;
        }
    }

    if let Ok(mut pool) = pool.lock() {
        pool.shutdown();
    }
    let _ = fs::remove_file(&socket_path);
    Ok(())
}

fn handle_client(mut stream: UnixStream, pool: Arc<Mutex<Pool>>) {
    let cloned = match stream.try_clone() {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut reader = BufReader::new(cloned);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let line = line.trim();
    if line == "PING" {
        let _ = writeln!(stream, "PONG\t{VERSION}");
        return;
    }
    let count = match line
        .strip_prefix("LEASE\t")
        .and_then(|value| value.parse::<usize>().ok())
    {
        Some(value) if value > 0 && value <= 64 => value,
        _ => {
            let _ = writeln!(stream, "ERR\tinvalid lease request");
            return;
        }
    };
    let leases = {
        let mut pool = match pool.lock() {
            Ok(value) => value,
            Err(_) => return,
        };
        match pool.acquire(count) {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(stream, "ERR\t{}", error.replace('\n', " "));
                return;
            }
        }
    };
    let payload = leases
        .iter()
        .map(|(id, url)| format!("{id}={url}"))
        .collect::<Vec<_>>()
        .join(",");
    if writeln!(stream, "OK\t{payload}").is_err() {
        if let Ok(mut pool) = pool.lock() {
            pool.release(&leases.iter().map(|(id, _)| *id).collect::<Vec<_>>());
        }
        return;
    }

    // The lease lives exactly as long as this client connection. If Node is
    // killed, EOF releases all browser slots without a PID-reaping protocol.
    let mut buffer = [0u8; 64];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    if let Ok(mut pool) = pool.lock() {
        pool.release(&leases.iter().map(|(id, _)| *id).collect::<Vec<_>>());
    }
}

fn launch_chrome(chrome: &Path, id: u64) -> Result<BrowserSlot, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let profile =
        std::env::temp_dir().join(format!("ryzerd-chrome-{}-{id}-{nonce}", std::process::id()));
    fs::create_dir_all(&profile).map_err(|error| format!("create Chrome profile: {error}"))?;
    let args = [
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-component-extensions-with-background-pages".into(),
        "--disable-default-apps".into(),
        "--disable-domain-reliability".into(),
        "--disable-extensions".into(),
        "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--metrics-recording-only".into(),
        "--disable-sync".into(),
        "--no-service-autorun".into(),
        "--no-startup-window".into(),
        "--password-store=basic".into(),
        "--use-mock-keychain".into(),
        "--headless=new".into(),
    ];
    let mut child = Command::new(chrome)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("launch Chrome: {error}"))?;
    let stderr = child.stderr.take().ok_or("Chrome stderr was unavailable")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(index) = line.find("DevTools listening on ") {
                let url = line[index + "DevTools listening on ".len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !url.is_empty() {
                    let _ = sender.send(url);
                }
            }
        }
    });
    let ws_url = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&profile);
            return Err("Chrome did not expose DevTools within 15 seconds".into());
        }
    };
    Ok(BrowserSlot {
        id,
        child,
        ws_url,
        profile,
        leased: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{digest_hex, Sha256};

    fn hash(chunks: &[&[u8]]) -> String {
        let mut hash = Sha256::new();
        for chunk in chunks {
            hash.update(chunk);
        }
        digest_hex(hash.finish())
    }

    #[test]
    fn matches_known_vectors_in_one_update() {
        assert_eq!(
            hash(&[b""]),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hash(&[b"abc"]),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// A partial block followed by more data must not lose the buffered bytes.
    /// This is the shape `hash_symlink` uses, and getting it wrong made every
    /// same-length symlink target collide.
    #[test]
    fn split_updates_match_a_single_update() {
        let message = b"symlink\0/nonexistent";
        let whole = hash(&[message]);
        for split in 0..message.len() {
            let (left, right) = message.split_at(split);
            assert_eq!(hash(&[left, right]), whole, "split at {split}");
        }
        assert_eq!(
            whole,
            "8190a2f3ba2a33c408fb08e930ee5201c4313cd5c2e322a7928dc30838179835"
        );
    }

    #[test]
    fn many_small_updates_match_one_large_update() {
        let message: Vec<u8> = (0..500u32).map(|index| (index % 251) as u8).collect();
        let whole = hash(&[&message]);
        let chunked: Vec<&[u8]> = message.chunks(7).collect();
        assert_eq!(hash(&chunked), whole);
    }

    /// Distinct targets of equal length must produce distinct digests.
    #[test]
    fn equal_length_messages_do_not_collide() {
        assert_ne!(
            hash(&[b"symlink\0", b"/nonexistent"]),
            hash(&[b"symlink\0", b"/XXXXXXXXXXX"])
        );
    }
}
