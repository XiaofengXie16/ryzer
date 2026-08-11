# Ryzer

[![npm version](https://img.shields.io/npm/v/ryzer.svg)](https://www.npmjs.com/package/ryzer)
[![CI](https://github.com/XiaofengXie16/ryzer/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaofengXie16/ryzer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ryzer.svg)](LICENSE)

Ryzer is a Chromium browser test runner with a TypeScript/JavaScript API. It is built around three ideas:

1. Wait inside the renderer, next to the DOM, instead of polling across a Node-to-browser protocol boundary.
2. Keep browser workers warm across CLI runs while deterministically clearing test state at each test boundary.
3. Compile related actions and assertions into a resident browser transaction that yields only for privileged input.
4. Fingerprint code natively and replay proven-safe passing results instead of opening a browser for unaffected work.

The result is a small Playwright-shaped API without a Playwright dependency. Ryzer talks directly to Chrome DevTools Protocol.

## Status

Ryzer 1.0 is a focused Chromium runner with compiled browser transactions, native dependency-aware incremental execution, adaptive worker scheduling, and deterministic application time. It is useful today for common single-page E2E flows, but it is not a drop-in Playwright replacement yet. See [Compatibility and limits](#compatibility-and-limits).

## Quick start

```bash
npm install --save-dev ryzer
```

```ts
// tests/search.spec.ts
import { expect, test } from "ryzer";

test("searches", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.getByRole("textbox", { name: "Query" }).fill("fast tests");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#results")).toContainText("fast tests");
});
```

```bash
npx ryzer test
```

TypeScript test files run directly. JavaScript, ESM, and CommonJS-style filename extensions are discovered as well.

## Configuration

```ts
// ryzer.config.ts
import { defineConfig } from "ryzer";

export default defineConfig({
  testDir: "tests",
  workers: 4,
  retries: 0,
  timeoutMs: 30_000,
  defaultTimeoutMs: 5_000,
  baseURL: "http://localhost:3000",
  isolation: "reset",
  outputDir: "ryzer-results",
  nativePool: true,
  incremental: true,
});
```

## API at a glance

```ts
await page.goto(url, { waitUntil: "load" });
await page.setContent("<button>Save</button>");

const save = page.getByRole("button", { name: "Save" });
await save.click();
await save.dblclick();
await save.hover();

await page.getByRole("textbox", { name: "Email" }).fill("me@example.com");
await page.getByLabel("Email").fill("me@example.com");
await page.getByPlaceholder("Search").fill("ryzer");
await page.getByTestId("result-row").filter({ hasText: "fast" }).first().click();
await page.locator("input[type=checkbox]").check();
await page.locator("select").selectOption("pro");
await page.locator("input").press("Enter");

await expect(page.locator("#status")).toBeVisible();
await expect(page.locator("#status")).toHaveText("Saved");
await expect(page.locator("li")).toHaveCount(3);
await expect(page.locator("input")).toHaveValue("me@example.com");

await page.route("**/api/profile", (route) =>
  route.fulfill({
    json: { name: "Ada" },
  }),
);
```

Supported runner features include parallel workers, retries in a clean context, `describe`, `beforeEach`, `afterEach`, line/dot/JSON reporters, screenshots, full HTML capture, and a CDP timeline on failure.

## Compiled transactions

Change `test(...)` to `test.flow(...)` to retain ordinary locator and assertion syntax while recording the body as one browser transaction:

```ts
test.flow("searches", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.getByLabel("Query").fill("compiled");
  await expect(page.locator("#status")).toHaveText("typing:compiled");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#status")).toHaveText("done:compiled");
});
```

Navigation, setup, routing, or evaluation may run before the first deferred locator step. Value-returning locator reads and page operations after recording begins fail explicitly because deferring them would change JavaScript semantics. Use a regular `test` for dynamic control flow.

`page.flow()` is the lower-level builder. It produces JSON-serializable transaction IR before touching the browser. The page-resident VM runs fills, waits, selectors, and assertions locally. It pauses at trusted mouse or keyboard instructions, lets the Node input broker perform the real CDP input, then resumes by transaction ID.

```ts
await page
  .flow()
  .fill(page.getByLabel("Query"), "compiled")
  .expectText("#status", "typing:compiled")
  .click(page.getByRole("button", { name: "Search" }))
  .expectText("#status", "done:compiled")
  .run();
```

For application behavior that intentionally depends on timers, a transaction can explicitly advance Chrome's synthetic clock:

```ts
await page
  .flow()
  .click("#start-expensive-retry")
  .advanceTime(5_001)
  .expectText("#status", "finished")
  .run();
```

This advances browser timers without sleeping for five wall-clock seconds. It is explicit because clock control has overhead and is counterproductive for already-tiny delays. Chrome marks virtual time experimental; it controls browser task time, not external servers, operating-system services, GPU behavior, or arbitrary work outside the page.

Inside `test.flow`, use the same explicit clock control with ordinary syntax:

```ts
await page.getByRole("button", { name: "Start" }).click();
await page.advanceTime(5_001);
await expect(page.locator("#status")).toHaveText("finished");
```

## Native incremental execution

Enable safe result capsules in configuration or on the CLI:

```bash
npx ryzer test --incremental
```

No test-body rewrite is required. Both ordinary `test(...)` and compiled `test.flow(...)` cases can qualify. The first run always executes in Chrome. Ryzer records the passing result, its recursively resolved local source dependencies, and the browser resources observed during the test. A dependency-free Rust scanner computes SHA-256 project fingerprints on later runs.

Ryzer replays a result only when all of these checks pass:

- the previous result passed and the runtime, Chrome binary metadata, launch semantics, and test request match;
- the test and its local import closure contain no recognized process, environment, random, clock, timer, dynamic-loading, filesystem, network, or external-package input;
- the test has no hooks, request routing, or HTTP/WebSocket resources, and its browser observation was hermetic;
- no dependency in the test's connected module-state component changed.

When every selected test is reusable, Ryzer returns the complete result before loading test modules and never launches Chrome. A mapped code edit runs only the affected dependency components. An unknown project change, an unsafe input, a failed/flaky result, or an environment change falls back to real browser execution. This is deliberately fail-closed: uncertainty costs time, never test coverage.

Capsules live in `.ryzer/capsules-v3.json`. Generated directories that cannot affect behavior can be excluded from fingerprinting:

```ts
export default defineConfig({
  incremental: true,
  incrementalExcludes: ["coverage", "generated-reports"],
});
```

Do not exclude application code, fixtures, lockfiles, or build output loaded by tests.

## Why it is fast

- Locator waits, strictness, visibility, hit testing, and assertions run in one renderer-side wait. A delayed assertion normally costs one CDP request, regardless of delay.
- The renderer engine is installed once per JavaScript realm; hot commands call it with a compact payload rather than retransmitting the engine.
- Mouse move/down/up commands are pipelined over one ordered socket round trip.
- Chrome auto-attaches new targets, removing an explicit attach round trip.
- Network instrumentation is enabled lazily only when `networkidle` is requested.
- Each worker owns a Chrome process, avoiding one-browser target contention.
- Reset isolation reuses a target and supplies the next fresh JavaScript realm through the test's own first navigation.
- A dependency-free Rust daemon keeps headless browser processes warm between CLI runs and grants crash-safe leases over a per-user Unix socket.
- Flow IR remains resident across trusted-input interrupts; resumes send only a transaction ID rather than the entire program.
- Locator queries use native candidate selectors and a realm-local open-shadow topology rather than walking every element for every operation.
- One realm-level mutation observer wakes active waits without constructing a new observer per instruction.
- The default scheduler uses measured adaptive concurrency: roughly two tests per worker, capped at eight and the available CPU count.
- On Node versions with stable type stripping, compatible TypeScript test files use the native loader; relative-source and non-erasable syntax conservatively fall back to `tsx`.
- The native SHA-256 planner runs before test loading. An exact complete-run hit bypasses TypeScript loading and Chrome entirely.
- Partial hits close over shared module dependencies, then size the browser-worker pool to the affected work instead of the original suite size.

The test API and CDP data path stay in TypeScript/JavaScript. Rust handles the narrow native jobs where it pays: cryptographic project fingerprinting, persistent process pooling, lease ownership, parallel cold launches, idle cleanup, and dead-slot replacement. Unsupported native platforms use the Node SHA-256 scanner and direct launcher without changing the API.

## Why it is stable

Ryzer does not use fixed sleeps for element readiness. The injected wait engine reacts to DOM mutations and animation frames, then verifies that an action target is attached, visible, enabled, geometrically stable across actual paint samples, and receives pointer events. Mutation notifications cannot masquerade as a stable frame. Assertions observe state until their deadline inside the page, avoiding scheduler-dependent polling gaps in Node. Runner timeouts actively cancel renderer work before hooks or retries begin. A crashed browser slot is replaced before a configured retry or the next test. Incremental reuse is opt-in and conservative: unrecognized dependencies or runtime inputs execute normally.

On failure, Ryzer writes:

- `screenshot.png`
- `page.html`
- `timeline.json` with the last 1,000 CDP events and command durations
- `error.txt`
- a run-level `results.json`

## Isolation modes

`reset` is the fast default. Every worker owns an incognito browser context. Between tests Ryzer clears local/session storage, IndexedDB, Cache Storage, cookies, HTTP cache, permissions, navigation history, request routes, and the prior JavaScript realm. When the next test begins with `page.goto`, that navigation supplies the fresh realm without an extra blank navigation. If it begins with another page operation, Ryzer first navigates to a clean `about:blank` realm automatically.

Chrome virtual time cannot be reliably returned to the wall clock. After a test advances time, Ryzer clears state and retires only that target. Its clean replacement is initialized concurrently inside the same incognito context, preventing synthetic time from leaking into later animation-frame deadlines without paying for a new browser process.

`context` creates and disposes a fresh incognito context and target for every test. Use it for defense-in-depth when tests directly mutate unsupported CDP state, install extensions, or exercise browser-level behavior outside Ryzer's reset contract:

```bash
npx ryzer test --isolation context
```

Retries always start from a clean prepared fixture; a failed page is never reused.

The native pool is enabled by default when a matching bundled daemon is present. Disable it for cold-start measurement or custom infrastructure:

```bash
npx ryzer test --no-native-pool
```

## Benchmarks

Run the matched speed suite:

```bash
npm run bench
```

Run cold, with persistent browser reuse disabled:

```bash
BENCH_RYZER_MODE=cold npm run bench
```

Run the one-test cold/warm startup comparison:

```bash
npm run bench:overhead
```

Run the repeated false-failure stress suite:

```bash
npm run bench:stability
```

Run the compiled transaction and deterministic-time comparisons:

```bash
npm run bench:flow
npm run bench:deterministic
npm run bench:flow-stability
npm run bench:large-dom
npm run bench:incremental
```

The baseline speed harness runs the same 48 tests with six transaction steps apiece, the same installed Chrome executable, four workers, no retries, alternating order, one excluded warmup, and five measured runs. The Flow harness uses eight workers in both lanes, matching the measured optimum for 48 tests. The overhead harness starts a fresh Node process containing one real TypeScript browser test. The stability harness runs identical near-deadline DOM updates with no retries and counts false failures. Machine-readable results are written to `benchmark-results/`.

On the development machine (`darwin-arm64`, Node 24.19, Chrome 151.0.7922.77, Playwright 1.62.1), the validated August 11, 2026 run was:

| Metric                        |   Ryzer | Playwright |                  Result |
| ----------------------------- | ------: | ---------: | ----------------------: |
| Warm speed median, 5 runs     | 2.726 s |    8.905 s |    **3.27× throughput** |
| Cold speed median, 5 runs     | 3.600 s |    8.755 s |    **2.43× throughput** |
| One-test warm startup, 7 runs | 0.234 s |    1.185 s |    **5.06× throughput** |
| One-test cold startup, 7 runs | 0.746 s |    1.185 s |    **1.59× throughput** |
| Speed-suite failures          | 0 / 240 |    0 / 240 |                    tied |
| Near-deadline false failures  | 0 / 480 |   16 / 480 | **100% fewer observed** |

The transaction-specific measurements were:

| Workload                                     |    Flow | Imperative Ryzer |  Strongest matched Playwright |       Flow result |
| -------------------------------------------- | ------: | ---------------: | ----------------------------: | ----------------: |
| 48 tests × 6 short interaction steps, 5 runs | 1.950 s |          2.084 s |                       7.823 s | **1.07× / 4.01×** |
| 16 tests with 1,000 ms app timers, 5 runs    | 0.938 s |          4.664 s | 2.884 s with Playwright Clock | **4.97× / 3.07×** |
| 50,000-node document × 6 operations, 5 runs  | 0.411 s |                — |                       1.395 s |     **— / 3.39×** |

The first ratio is Flow versus imperative Ryzer; the second is Flow versus the strongest equivalent Playwright lane. In the timer workload, real-time Playwright measured 8.082 s, or 8.62× slower than Flow, but the fair speed comparison is the 3.07× result against Playwright's own installed virtual clock. The deterministic result is not presented as a universal speedup: it applies when virtualizing application time preserves the behavior the test intends to verify.

The virtual-time Flow also completed **320 / 320 no-retry cases** across 20 fresh runs. This bounded result demonstrates repeatability for the included timer workload; observing zero failures does not prove a zero true flake rate.

The native incremental harness uses the same 64 interaction tests in both runners and includes process startup. Sixteen tests belong to the edited dependency component:

| Incremental path   | Median / run | Browser tests executed | Native-cached | Result versus Playwright full |
| ------------------ | -----------: | ---------------------: | ------------: | ----------------------------: |
| Playwright full    |      7.727 s |                     64 |             0 |                      baseline |
| Ryzer full         |      1.222 s |                     64 |             0 |              **6.32× faster** |
| Ryzer unchanged    |      0.078 s |                      0 |            64 |             **98.56× faster** |
| Ryzer partial edit |      0.734 s |                     16 |            48 |             **10.53× faster** |

The unchanged lane's median engine time after Node startup was 13.2 ms. The partial edit was 1.66× faster than full Ryzer. One warmup per runner was excluded; across three measured full-run samples and five unchanged samples, the harness observed zero failures. These are workload-specific results; the speedup shrinks as a change affects more dependency components or forces conservative fallback.

Both preset acceptance gates passed: at least 1.5× throughput and at most half Playwright's false-failure rate on the included stress workload.

These benchmarks prove performance for the included workload and machine; they are not a universal claim that every suite will be faster. Run both harnesses on your CI hardware and add representative application flows before adopting.

## Contributing and releases

Run `npm run check`, `npm run build`, `npm run test:unit`, and `npm test` before opening a pull request. Oxfmt, Oxlint, TypeScript, Rust formatting, and Clippy are enforced in CI. User-visible changes include a Changeset created with `npm run changeset`.

Changesets maintains a version pull request on `main`. Merging that pull request publishes to npm through GitHub Actions OIDC trusted publishing, records provenance, tags the version, and creates a GitHub release. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Compatibility and limits

Ryzer intentionally covers a smaller surface than Playwright 1.x.

Available now:

- Chromium/Chrome/Edge through CDP
- deep open-shadow CSS and text locators; label, placeholder, test-id, and a practical subset of ARIA role/name locators
- locator chaining, text filtering, and first/last/nth indexing
- real trusted mouse clicks, double clicks, hover, keyboard presses
- fill, checkbox/radio, and select controls
- auto-retrying visibility, text, count, value, and attribute assertions
- navigation, evaluation, HTML, screenshots, and request interception
- parallel runner, hooks, retries, isolation, reporters, and failure artifacts
- `test.flow` ordinary-syntax recording, compiled resident Flow IR, trusted-input interrupts, and explicit virtual-time steps
- opt-in native SHA-256 incremental selection with complete-run replay, dependency-component invalidation, and conservative fallback

Not implemented yet:

- Firefox and WebKit
- frames, popups/multiple pages as first-class fixtures, downloads, file upload, video, and WebSocket routing
- Playwright's full accessible-name algorithm, closed shadow roots, snapshots, and complete assertion set
- a trace viewer UI (the raw failure timeline is available)
- Playwright projects/devices and its VS Code integration
- browser-process snapshots/forks or patched-browser execution; Chromium does not expose a safe process-fork primitive through CDP

The compatibility tests in `tests/playwright-reference.spec.ts` are adapted from representative Apache-2.0 Playwright cases for click removal races, double click, visibility, fill validation/events, and idempotent checkbox behavior. Passing those cases does not imply full Playwright conformance.

## Development

```bash
npm install
npm run check
npm run test:unit
npm test
npm run build
npm run bench
npm run bench:overhead
npm run bench:flow
npm run bench:deterministic
npm run bench:flow-stability
npm run bench:large-dom
npm run bench:stability
npm run bench:incremental
```

Chrome is discovered from `CHROME_PATH` or conventional macOS/Linux locations. The release package currently bundles native pooling for `darwin-arm64`; every other supported Node platform falls back to the direct launcher without changing the API.
