# Ryzer architecture

## Data path

```text
TypeScript test
    │
    ▼
native SHA-256 planner ── dependency graph ── result capsule
    │                                           │
    │ unchanged complete run                    └── native result replay; no test load or Chrome
    ▼
single-process runner ── affected-test queue per worker
    │        │           │
    │        └── Flow compiler ── resident transaction VM
    │                    │          │
    │                    │          └── privileged-input interrupts
    │                    └── Unix lease ── Rust ryzerd ── warm Chrome pool
    ▼
ordered CDP WebSocket ── one leased headless Chrome per worker
    │
    ├── browser process: contexts, targets, input, network interception
    │
    └── renderer process: injected locator/wait/assertion engine
```

The runner stays deliberately thin. Chrome is responsible for browser behavior; the injected runtime is responsible for DOM-dependent waiting. `ryzerd` owns process lifetime but is not a proxy: test commands still travel directly from Node to Chrome. No selector polling loop crosses the protocol boundary.

## Native incremental planner

Incremental mode begins before test discovery. The Rust binary recursively fingerprints project files with a dependency-free SHA-256 implementation; the JavaScript fallback uses Node's SHA-256 implementation. Cache/output directories, `.git`, `node_modules`, and explicit generated-only exclusions are omitted. Regular files are content-hashed, same-size edits are detected, filenames are escaped in the native protocol, and symlinks are fingerprinted without following directory cycles.

An exact fingerprint, environment signature, and run-request match can replay a complete passing run before importing TypeScript. Otherwise the runner loads tests and constructs recursive local import closures. Dynamic inputs, hooks, external packages, routes, realtime clocks/timers, Node I/O, external browser resources, and project-escaping symlinks make a result ineligible. Browser execution records navigation and Resource Timing URLs; only local inert protocols and mapped project files remain hermetic.

Selection is closed over connected dependency components. If an active test and a cached test share a test file or imported module, both execute. This preserves module and test-file state that a skipped test body could otherwise perturb. Changed mapped dependencies invalidate their components; any changed file outside the known graph invalidates the whole selection. Cache writes are atomic, malformed caches are ignored, failures and flaky results are never recorded, and uncertainty always falls back to Chrome.

## Renderer-side waits

Every locator operation is one `Runtime.evaluate({ awaitPromise: true })`. The injected promise combines a realm-level `MutationObserver` with `requestAnimationFrame`. It can react immediately to DOM/text/attribute changes while counting geometric stability only on actual paint samples.

The runtime is installed once in the current realm and registered as a new-document script. Subsequent operations send only a serialized locator and operation, avoiding a large repeated source payload.

The query planner asks native selectors only for elements capable of matching the requested locator kind. A realm-local registry tracks open shadow roots through a native-looking `attachShadow` proxy, avoiding a full light-DOM walk merely to rediscover shadow topology. Element identity is deliberately not cached across instructions: JavaScript can change accessible names, values, strict-match counts, or next-frame geometry without producing a safely classifiable DOM mutation.

Action readiness requires:

1. exactly one match for strict operations;
2. an attached element with a non-empty layout box;
3. enabled state and pointer events;
4. the same geometry across consecutive frames;
5. a center point whose hit target is the element or its DOM family.

The Node side then sends trusted CDP input. Mouse move, press, and release are sent without awaiting individual responses; WebSocket and CDP ordering preserve their order.

Deterministic semantic errors—invalid selectors, unsupported fill controls, malformed native values, and strictness violations—fail immediately. Transient readiness failures retry until the operation deadline.

## Compiled Flow VM

Imperative locator calls remain available. `page.flow()` instead records actions and expectations as serializable IR. On `run()`, Node sends the program once through `beginFlow`. The renderer stores the steps and instruction pointer in a transaction table and executes until completion or a privileged boundary.

`test.flow()` is a runtime compiler for ordinary test syntax. Void locator actions and assertions record into the same IR while the callback runs. Navigation/setup may occur before recording begins. Value-returning reads and mid-transaction page operations are rejected instead of being reordered. This preserves closure access and avoids shipping a TypeScript AST compiler while making the semantic boundary explicit.

Trusted click, double-click, hover, and keyboard steps return a small interrupt containing coordinates or a key. Node dispatches native CDP input and calls `resumeFlow(flowId)`. The full IR is not resent. Renderer-only fills, selects, waits, and assertions can run back-to-back without returning to Node.

The runner's timeout cancellation clears both active locator promises and resident transaction state. Step failure also deletes the transaction before returning the indexed error, so retries cannot resume stale instructions.

An `advanceTime` instruction yields to the coordinator, which applies a bounded `Emulation.setVirtualTimePolicy` budget. This makes long application timers deterministic and fast. It remains explicit because protocol control costs more than simply waiting for very short timers and because Chrome labels the API experimental. CDP cannot reliably restore wall-clock behavior afterward, so reset cleanup overlaps initialization of a clean replacement target and retires the synthetic-time target before the next test.

## Worker model

Each worker owns a browser process. Profiling one browser shared by four workers showed Chrome serializing target creation, attachment, navigation, and renderer commands; separate processes improved both throughput and crash containment.

On supported systems a dependency-free Rust daemon retains those worker processes after the Node CLI exits. A lease is tied to the client socket: EOF releases it even if Node is killed. Cold workers launch concurrently; dead processes are removed before the next lease; the daemon exits and removes profiles after its idle deadline. Socket permissions are owner-only. Custom launch arguments, headed mode, or an unavailable binary select the direct launcher.

The test scheduler itself is an in-process atomic cursor. This avoids Playwright-style Node worker subprocesses while still running browser work in parallel Chrome processes. Its default concurrency is adaptive—approximately two tests per worker for full runs, with a smaller impact-aware pool for partial reruns, capped at eight and available CPUs—based on measured 2/4/8/12/24/48-test scaling curves.

## Reset isolation

Reset mode keeps one incognito context and page per worker. The boundary has two phases:

1. Clear state while the current document is active: local/session storage, IndexedDB, Cache Storage, cookies, browser cache, permissions, history, routes, request accounting.
2. Mark the JavaScript realm dirty. The next `goto` supplies a new realm. Any other first page operation forces a completed `about:blank` navigation before executing.

This avoids a redundant blank navigation and all context/target creation on the normal `goto`-first path. Context mode remains available when a suite needs a new Chrome storage partition per test.

## Navigation correctness

`goto` enables lifecycle events and binds completion to the specific `loaderId` returned by `Page.navigate`. This prevents a late load event from a previous navigation from satisfying the next navigation wait.

## Failure model

Tests time out at the runner boundary. Timeout cleanup cancels active injected waits and stops navigation before hooks continue. Failed fixtures are captured and discarded. Retry attempts never reuse the failed document. Teardown uses `Target.disposeBrowserContext`, which atomically closes all context pages in one protocol command.

If the CDP connection dies, the worker leases a replacement browser before retrying or dequeuing another test. A deliberately crashed-browser test and a deliberately timed-out-renderer test cover both recovery paths.

The protocol connection retains a bounded timeline of commands, events, durations, and errors. Failure capture is parallelized and best-effort so a screenshot error cannot hide the original test error.

## Measured optimization decisions

- Direct CDP was retained for test commands; Rust is used for persistent process orchestration, where it removes repeated launch cost without adding a proxy hop.
- Re-sending the injected engine on every locator call was removed; compact resident-runtime calls materially improved the matched workload.
- Compiled transactions removed additional controller round trips, producing a measured 1.07x gain over imperative Ryzer and 4.01x throughput versus Playwright on the final input-heavy workload.
- Explicit synthetic-time instructions produced a measured 4.97x gain over real-time Ryzer and 3.07x over Playwright's equivalent installed-clock lane on matched 1,000 ms application timers. Against real-time Playwright the gain was 8.62x, but that is a time-virtualization benefit rather than the fair engine comparison. Synthetic time was not enabled for tiny-delay tests where control overhead lost time.
- Auto-attach removed roughly one 45 ms target-attachment round trip in serial profiling.
- Lazy domain enabling removed DOM/Runtime/Network initialization from tests that do not use those event streams.
- One Chrome shared by four workers was rejected after it made the first matched benchmark slower than Playwright.
- Speculative target prewarming was rejected after it increased renderer contention.
- Lazy reset replaced a roughly 40 ms `about:blank` load with a roughly 7–12 ms state clear on the normal path.
- Native candidate-selector planning cut a 50,000-node transaction from roughly 0.79 s to 0.41 s while retaining fresh strict resolution; the formal matched result was 3.39x versus Playwright.
- Eight workers improved the 48-test Flow workload from roughly 2.62 s at four workers to 1.96 s. Twelve tests peaked at six workers, motivating the adaptive rather than fixed default.
- Compatible Node 24 TypeScript files use native type stripping; the relative-source/non-erasable fallback remains `tsx` for Node 20 compatibility.
- Reusing cached target geometry was rejected after a next-frame movement test observed an unsafe click at the old coordinate.
- Input/resume pipelining was removed after profiles showed no repeatable gain beyond sub-millisecond input acknowledgements.
- A persistent inert renderer in daemon-owned Chrome was rejected after seven-run warm startup regressed from roughly 0.214 s to 0.219 s and consumed more memory.
- Native complete-run capsules reduced the 64-test unchanged path to a 0.078 s process median (13.2 ms inside the engine), 98.56x faster than the matched 7.727 s Playwright full run. A 16-test affected component with 48 cached results completed in 0.734 s, 10.53x faster than Playwright and 1.66x faster than full Ryzer.
- Per-test selection without dependency-component closure was rejected because skipping one body can alter shared module state observed by another test. Component closure intentionally trades some cache hits for deterministic semantics.

## Practical optimization boundary

The remaining large latency components are real browser work: renderer paint frames required for stable targeting, trusted input dispatch, navigation, and Chrome process startup. Removing those waits would change test semantics. Three tempting shortcuts were measured and rejected: cross-instruction geometry caching clicked a target's previous coordinate after next-frame movement, input/resume pipelining produced no repeatable gain, and retaining an inert renderer made startup slower.

Ryzer 1.0 takes the application-integration path: safe test-impact selection changes how much browser work is performed, while compiled transactions optimize the work that remains. The next architectural jump would require capabilities outside stock Chromium CDP: a supported browser-process snapshot/fork primitive or a patched browser that executes the transaction VM natively. Fresh locator resolution, actual-paint stability, and real trusted input remain the correctness floor for every test that actually executes.
