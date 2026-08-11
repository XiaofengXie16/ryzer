import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readlink, readdir, readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveChromeExecutable } from "./browser.js";
import type { RunnerConfig } from "./types.js";

export interface NativeBrowserSlot {
  id: number;
  wsUrl: string;
}

export interface NativePoolLease {
  slots: NativeBrowserSlot[];
  release(): void;
}

export interface ProjectFingerprint {
  engine: "native-sha256" | "node-sha256";
  files: Record<string, string>;
}

const PROTOCOL_VERSION = "7";

export async function fingerprintProject(
  root: string,
  excludes: string[] = [],
): Promise<ProjectFingerprint> {
  const absoluteRoot = resolve(root);
  const normalizedExcludes = [
    ...new Set(
      [".git", "node_modules", ...excludes]
        .map((value) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
        .filter(Boolean),
    ),
  ];
  const binary = await nativeBinary();
  if (binary) {
    try {
      const args = ["fingerprint", "--root", absoluteRoot];
      for (const exclude of normalizedExcludes) args.push("--exclude", exclude);
      const output = await collectProcess(binary, args);
      const files: Record<string, string> = {};
      for (const line of output.split("\n")) {
        if (!line) continue;
        const [escapedPath, size, , hash] = line.split("\t");
        if (!escapedPath || !size || !hash)
          throw new Error(`Malformed native fingerprint line: ${line}`);
        files[unescapeField(escapedPath)] = `${size}:${hash}`;
      }
      return { engine: "native-sha256", files };
    } catch (error) {
      debug(
        `native fingerprint unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const files: Record<string, string> = {};
  await fingerprintWithNode(absoluteRoot, absoluteRoot, new Set(normalizedExcludes), files);
  return { engine: "node-sha256", files };
}

export async function acquireNativePool(
  count: number,
  config: RunnerConfig,
): Promise<NativePoolLease | undefined> {
  if (!nativePoolCompatible(config)) return undefined;
  const binary = await nativeBinary();
  if (!binary) return undefined;
  const chrome = await resolveChromeExecutable(config.executablePath);
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().username;
  const key = createHash("sha256").update(chrome).digest("hex").slice(0, 12);
  // macOS limits Unix-domain socket paths to roughly 104 bytes. /tmp keeps the
  // endpoint short even when os.tmpdir() is a deeply nested per-user path.
  const socketPath = join(shortTmpDir(), `ryzerd-${uid}-v${PROTOCOL_VERSION}-${key}.sock`);
  const timeoutMs = config.launchTimeoutMs ?? 15_000;

  let socket: Socket | undefined;
  try {
    socket = await connect(socketPath, 100).catch(() => undefined);
    if (!socket) {
      const idleSeconds = process.env.RYZER_DAEMON_IDLE_SECONDS ?? "600";
      const child = spawn(
        binary,
        ["--socket", socketPath, "--chrome", chrome, "--idle-seconds", idleSeconds],
        { detached: true, stdio: "ignore" },
      );
      // A corrupt/missing optional binary must never crash the JS runner.
      child.once("error", (error) => debug(`could not start native daemon: ${error.message}`));
      child.unref();
      socket = await waitForDaemon(socketPath, Math.min(timeoutMs, 5_000));
    }
  } catch (error) {
    debug(`native daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  try {
    socket.write(`LEASE\t${count}\n`);
    const response = await readLine(socket, timeoutMs);
    if (!response.startsWith("OK\t")) throw new Error(response.replace(/^ERR\t/, ""));
    const payload = response.slice(3);
    const slots = payload
      .split(",")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        const id = Number(entry.slice(0, separator));
        const wsUrl = entry.slice(separator + 1);
        if (separator < 1 || !Number.isInteger(id) || !wsUrl.startsWith("ws://")) {
          throw new Error(`Invalid ryzerd lease response: ${entry}`);
        }
        return { id, wsUrl };
      });
    if (slots.length !== count)
      throw new Error(`ryzerd returned ${slots.length} of ${count} requested slots`);
    let released = false;
    return {
      slots,
      release() {
        if (released) return;
        released = true;
        socket.destroy();
      },
    };
  } catch (error) {
    socket.destroy();
    debug(`native pool unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function nativePoolCompatible(config: RunnerConfig): boolean {
  return (
    config.nativePool !== false &&
    process.env.RYZER_DISABLE_DAEMON !== "1" &&
    config.headless !== false &&
    !config.args?.length &&
    !config.env
  );
}

async function nativeBinary(): Promise<string | undefined> {
  const override = process.env.RYZER_NATIVE_BINARY;
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!override && (!platform || !arch)) return undefined;
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidate = override ?? join(packageRoot, "native", "bin", `ryzerd-${platform}-${arch}`);
  try {
    await access(candidate);
    return candidate;
  } catch {
    debug(`native daemon binary not found at ${candidate}`);
    return undefined;
  }
}

async function collectProcess(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(Buffer.concat(stderr).toString("utf8").trim() || `fingerprint exited ${code}`),
        );
    });
  });
}

async function fingerprintWithNode(
  root: string,
  directory: string,
  excludes: Set<string>,
  output: Record<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if ([...excludes].some((exclude) => path === exclude || path.startsWith(`${exclude}/`)))
      continue;
    if (entry.isDirectory()) {
      await fingerprintWithNode(root, absolute, excludes, output);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute);
      const hash = createHash("sha256").update("symlink\0").update(target);
      const targetStat = await stat(absolute).catch(() => undefined);
      if (targetStat?.isFile()) hash.update("\0file\0").update(await readFile(absolute));
      output[path] = `${Buffer.byteLength(target)}:${hash.digest("hex")}`;
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await readFile(absolute);
    output[path] = `${contents.byteLength}:${createHash("sha256").update(contents).digest("hex")}`;
  }
}

function unescapeField(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
}

function shortTmpDir(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

async function waitForDaemon(path: string, timeoutMs: number): Promise<Socket> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      return await connect(path, 100);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out starting ryzerd");
}

function connect(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${path}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      // The lease intentionally outlives the response read. A daemon exit
      // should make the socket close quietly, never surface as an uncaught
      // EventEmitter error in the test process.
      socket.on("error", () => undefined);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}

function readLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for ryzerd")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(undefined, buffer.slice(0, newline).replace(/\r$/, ""));
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("ryzerd closed before responding"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function debug(message: string): void {
  if (process.env.RYZER_DEBUG === "1") process.stderr.write(`[ryzer] ${message}\n`);
}
