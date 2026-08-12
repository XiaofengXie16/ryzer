import { mkdir, readdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Browser } from "./browser.js";
import {
  CapsuleSession,
  prepareCapsule,
  replayCompleteCapsule,
  type CapsuleObservation,
  type CapsuleStats,
} from "./capsule.js";
import { importTypeScript } from "./loader.js";
import { acquireNativePool, type NativePoolLease } from "./native.js";
import { _registeredTests, _resetRegistry, _setCurrentFile, type RegisteredTest } from "./test.js";
import { trace } from "./trace.js";
import type { RunnerConfig, TestFixtures } from "./types.js";

export interface TestAttempt {
  attempt: number;
  durationMs: number;
  error?: string;
  artifactDir?: string;
}

export interface TestResult {
  title: string;
  file: string;
  status: "passed" | "failed" | "flaky" | "skipped";
  durationMs: number;
  attempts: TestAttempt[];
  cached?: boolean;
  cacheSourceDurationMs?: number;
}

export interface RunSummary {
  startedAt: string;
  durationMs: number;
  counts: { passed: number; failed: number; flaky: number; skipped: number; cached: number };
  results: TestResult[];
  runtime: "native-pool" | "native-capsule" | "direct";
  capsule?: CapsuleStats;
}

export async function runTests(
  config: RunnerConfig = {},
  explicitPaths: string[] = [],
): Promise<RunSummary> {
  trace("runTests:enter");
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const outputDir = resolve(config.outputDir ?? "ryzer-results");
  const capsulePreflight = config.incremental
    ? await prepareCapsule(config, explicitPaths)
    : undefined;
  if (config.incremental) trace("capsule:preflight");
  const completeReplay = capsulePreflight ? replayCompleteCapsule(capsulePreflight) : undefined;
  if (completeReplay) {
    const results: TestResult[] = completeReplay.results.map((result) => ({
      title: result.title,
      file: resolve(capsulePreflight!.root, result.file),
      status: result.status,
      durationMs: 0,
      attempts: [],
      ...(result.status === "passed"
        ? { cached: true, cacheSourceDurationMs: result.sourceDurationMs }
        : {}),
    }));
    const reporter = new Reporter(config.reporter ?? "line");
    reporter.start(results.length, 0);
    for (const result of results) reporter.test(result);
    const summary = createSummary(
      startedAt,
      started,
      results,
      "native-capsule",
      completeReplay.stats,
    );
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "results.json"), JSON.stringify(summary, null, 2));
    reporter.end(summary);
    return summary;
  }
  const files = await discoverTests(
    explicitPaths.length ? explicitPaths : [config.testDir ?? "tests"],
    config.match,
  );
  if (files.length === 0) throw new Error("No test files found");
  trace("discover:done", `${files.length} file(s)`);
  _resetRegistry();
  for (const file of files) {
    _setCurrentFile(file);
    await importTestFile(file);
  }
  trace("import:done");
  const registered = _registeredTests();
  const hasOnly = registered.some((item) => item.only);
  const tests = registered.filter((item) => !hasOnly || item.only);
  if (tests.length === 0)
    throw new Error(`No tests were registered by ${files.length} test file(s)`);

  const capsule = config.incremental
    ? await CapsuleSession.create(config, tests, capsulePreflight)
    : undefined;
  const results: TestResult[] = [];
  const activeIndices: number[] = [];
  for (let index = 0; index < tests.length; index++) {
    const item = tests[index]!;
    if (item.skipped) {
      results[index] = skippedResult(item);
      continue;
    }
    const cached = capsule?.cachedResult(item);
    if (cached) {
      results[index] = {
        title: item.title,
        file: item.file,
        status: "passed",
        durationMs: 0,
        attempts: [],
        cached: true,
        cacheSourceDurationMs: cached.durationMs,
      };
      continue;
    }
    activeIndices.push(index);
  }
  const partialIncrementalRun = Boolean(
    capsule && activeIndices.length < tests.filter((test) => !test.skipped).length,
  );
  const adaptiveWorkers = Math.min(
    8,
    availableParallelism(),
    partialIncrementalRun
      ? Math.max(1, Math.ceil(activeIndices.length / 4))
      : Math.max(2, Math.ceil(activeIndices.length / 2)),
  );
  const concurrency =
    activeIndices.length === 0
      ? 0
      : Math.max(1, Math.min(config.workers ?? adaptiveWorkers, activeIndices.length));
  const reporter = new Reporter(config.reporter ?? "line");
  reporter.start(tests.length, concurrency);
  for (const result of results) if (result) reporter.test(result);

  if (activeIndices.length === 0) {
    capsule?.finalize(tests, results);
    await capsule?.save();
    const summary = createSummary(startedAt, started, results, "native-capsule", capsule?.stats);
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "results.json"), JSON.stringify(summary, null, 2));
    reporter.end(summary);
    return summary;
  }
  // A browser process is the real contention boundary: one Chrome shared by
  // many workers serializes target creation, navigation, and renderer work.
  // Launching one lightweight headless browser per worker is measurably faster
  // and also contains process crashes to a single worker.
  trace("workers:launch-start", `${concurrency} worker(s)`);
  const fleet = await launchWorkers(concurrency, config);
  trace("workers:ready", fleet.nativeUsed ? "native-pool" : "direct");
  const { browsers } = fleet;
  let cursor = 0;
  try {
    const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
      let browser = browsers[workerIndex];
      if (!browser) return;
      let reusable: PreparedFixture | undefined;
      try {
        for (;;) {
          const index = activeIndices[cursor++];
          if (index === undefined) return;
          const item = tests[index]!;
          if (browser.connection.closed) {
            if (reusable) await reusable.context.close();
            reusable = undefined;
            browser = await fleet.recover(workerIndex);
          }
          const execution = await executeTest(
            browser,
            item,
            config,
            outputDir,
            reusable,
            () => fleet.recover(workerIndex),
            () => cursor < activeIndices.length,
            Boolean(capsule),
          );
          browser = execution.browser;
          reusable = execution.reusable;
          results[index] = execution.result;
          await capsule?.record(item, execution.result, execution.capsuleObservation);
          reporter.test(execution.result);
        }
      } finally {
        if (reusable) await reusable.context.close();
      }
    });
    await Promise.all(workers);
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    for (const lease of fleet.leases) lease.release();
  }
  capsule?.finalize(tests, results);
  await capsule?.save();
  const summary = createSummary(
    startedAt,
    started,
    results,
    fleet.nativeUsed ? "native-pool" : "direct",
    capsule?.stats,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "results.json"), JSON.stringify(summary, null, 2));
  reporter.end(summary);
  return summary;
}

async function importTestFile(file: string): Promise<void> {
  await importTypeScript(`${pathToFileURL(file).href}?ryzer=${Date.now()}`);
}

interface WorkerFleet {
  browsers: Browser[];
  leases: NativePoolLease[];
  nativeUsed: boolean;
  recover(index: number): Promise<Browser>;
}

async function launchWorkers(count: number, config: RunnerConfig): Promise<WorkerFleet> {
  const leases: NativePoolLease[] = [];
  let browsers: Browser[] | undefined;
  // Retry once: a daemon can discover a crashed warm slot only after the
  // failed lease is released. The second lease replaces it automatically.
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await acquireNativePool(count, config);
    if (!lease) {
      // Optional-native incompatibility is cheap to re-check, while a busy or
      // just-restarted daemon often succeeds immediately on the second try.
      if (attempt === 0) continue;
      break;
    }
    const connections = await Promise.allSettled(
      lease.slots.map((slot) => Browser.connect(slot.wsUrl, config.launchTimeoutMs)),
    );
    const failed = connections.find((result) => result.status === "rejected");
    if (!failed) {
      browsers = connections.map((result) => (result as PromiseFulfilledResult<Browser>).value);
      leases.push(lease);
      break;
    }
    await Promise.allSettled(
      connections
        .filter(
          (result): result is PromiseFulfilledResult<Browser> => result.status === "fulfilled",
        )
        .map((result) => result.value.close()),
    );
    lease.release();
  }
  browsers ??= await Promise.all(Array.from({ length: count }, () => Browser.launch(config)));
  const fleet: WorkerFleet = {
    browsers,
    leases,
    nativeUsed: leases.length > 0,
    async recover(index: number): Promise<Browser> {
      const previous = fleet.browsers[index];
      if (previous) await previous.close().catch(() => undefined);
      const lease = await acquireNativePool(1, config);
      if (lease) {
        try {
          const browser = await Browser.connect(lease.slots[0]!.wsUrl, config.launchTimeoutMs);
          fleet.leases.push(lease);
          fleet.nativeUsed = true;
          fleet.browsers[index] = browser;
          return browser;
        } catch {
          lease.release();
        }
      }
      const browser = await Browser.launch(config);
      fleet.browsers[index] = browser;
      return browser;
    },
  };
  return fleet;
}

async function executeTest(
  browser: Browser,
  item: RegisteredTest,
  config: RunnerConfig,
  outputDir: string,
  reusable?: PreparedFixture,
  recoverBrowser?: () => Promise<Browser>,
  shouldPrepareNext?: () => boolean,
  observeCapsule = false,
): Promise<{
  result: TestResult;
  reusable?: PreparedFixture;
  browser: Browser;
  capsuleObservation?: CapsuleObservation;
}> {
  const testStarted = performance.now();
  const attempts: TestAttempt[] = [];
  const maxAttempts = (config.retries ?? 0) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStarted = performance.now();
    if (browser.connection.closed && recoverBrowser) {
      if (reusable) await reusable.context.close();
      reusable = undefined;
      browser = await recoverBrowser();
    }
    let fixture: PreparedFixture;
    try {
      fixture = reusable ?? (await prepareFixture(browser, config));
    } catch (caught) {
      const error = formatError(caught);
      attempts.push({ attempt, durationMs: performance.now() - attemptStarted, error });
      if (browser.connection.closed && recoverBrowser && attempt < maxAttempts) {
        browser = await recoverBrowser();
      }
      continue;
    }
    reusable = undefined;
    const { context, page } = fixture;
    if (observeCapsule) await page._beginCapsuleObservation();
    const fixtures: TestFixtures = { page, context, browser };
    let error: unknown;
    try {
      await withTimeout(
        async () => {
          for (const hook of item.beforeEach) await hook(fixtures);
          await item.fn(fixtures);
        },
        config.timeoutMs ?? 30_000,
        `Test timed out after ${config.timeoutMs ?? 30_000}ms`,
        () => page._cancelPending(`Test timed out after ${config.timeoutMs ?? 30_000}ms`),
      );
    } catch (caught) {
      error = caught;
    }
    if (error) {
      try {
        for (const hook of item.afterEach) await hook(fixtures);
      } catch (hookError) {
        error = new Error(`${formatError(error)}\nafterEach failed: ${formatError(hookError)}`);
      }
      const artifactDir = join(
        outputDir,
        slug(`${basename(item.file, extname(item.file))}-${item.title}-${attempt}`),
      );
      await captureFailure(page, browser, artifactDir, error);
      attempts.push({
        attempt,
        durationMs: performance.now() - attemptStarted,
        error: formatError(error),
        artifactDir,
      });
      await context.close();
      if (browser.connection.closed && recoverBrowser && attempt < maxAttempts) {
        browser = await recoverBrowser();
      }
      continue;
    }
    try {
      for (const hook of item.afterEach) await hook(fixtures);
    } catch (hookError) {
      const artifactDir = join(
        outputDir,
        slug(`${basename(item.file, extname(item.file))}-${item.title}-${attempt}`),
      );
      await captureFailure(page, browser, artifactDir, hookError);
      attempts.push({
        attempt,
        durationMs: performance.now() - attemptStarted,
        error: `afterEach failed: ${formatError(hookError)}`,
        artifactDir,
      });
      await context.close();
      continue;
    }
    attempts.push({ attempt, durationMs: performance.now() - attemptStarted });
    const capsuleObservation = observeCapsule ? await page._finishCapsuleObservation() : undefined;
    let nextFixture: PreparedFixture | undefined;
    if (!shouldPrepareNext?.()) {
      await context.close();
    } else if ((config.isolation ?? "reset") === "reset") {
      let replacement: Promise<PreparedFixture["page"]> | undefined;
      try {
        // A virtual-time target must be retired. Initialize its about:blank
        // replacement concurrently with cleanup; the next test cannot use it
        // until _resetForNextTest has cleared context/browser state.
        replacement = page._needsTargetRetirement() ? context.newPage() : undefined;
        if (await page._resetForNextTest()) nextFixture = fixture;
        else {
          await page.close();
          nextFixture = { context, page: await replacement! };
        }
      } catch {
        await replacement?.catch(() => undefined);
        await context.close();
      }
    } else {
      await context.close();
    }
    return {
      result: {
        title: item.title,
        file: item.file,
        status: attempt === 1 ? "passed" : "flaky",
        durationMs: performance.now() - testStarted,
        attempts,
      },
      reusable: nextFixture,
      browser,
      capsuleObservation,
    };
  }
  return {
    result: {
      title: item.title,
      file: item.file,
      status: "failed",
      durationMs: performance.now() - testStarted,
      attempts,
    },
    browser,
  };
}

function createSummary(
  startedAt: string,
  started: number,
  results: TestResult[],
  runtime: RunSummary["runtime"],
  capsule?: CapsuleStats,
): RunSummary {
  return {
    startedAt,
    durationMs: performance.now() - started,
    counts: {
      passed: results.filter((item) => item.status === "passed").length,
      failed: results.filter((item) => item.status === "failed").length,
      flaky: results.filter((item) => item.status === "flaky").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      cached: results.filter((item) => item.cached).length,
    },
    results,
    runtime,
    ...(capsule ? { capsule } : {}),
  };
}

interface PreparedFixture {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["newPage"]>>;
}

async function prepareFixture(browser: Browser, config: RunnerConfig): Promise<PreparedFixture> {
  const context = await browser.newContext(config);
  try {
    const page = await context.newPage();
    trace("fixture:ready");
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function captureFailure(
  page: TestFixtures["page"],
  browser: Browser,
  dir: string,
  error: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const writes: Array<Promise<unknown>> = [
    writeFile(join(dir, "error.txt"), formatError(error)),
    writeFile(
      join(dir, "timeline.json"),
      JSON.stringify(browser.connection.timeline.slice(-1_000), null, 2),
    ),
  ];
  writes.push(
    page
      .content()
      .then((html) => writeFile(join(dir, "page.html"), html))
      .catch(() => undefined),
  );
  writes.push(
    page.screenshot({ path: join(dir, "screenshot.png"), fullPage: true }).catch(() => undefined),
  );
  await Promise.allSettled(writes);
}

async function discoverTests(paths: string[], customMatch?: RegExp): Promise<string[]> {
  const match = customMatch ?? /(?:\.test|\.spec)\.[cm]?[jt]sx?$/;
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const absolute = resolve(path);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      if (match.test(absolute)) found.push(absolute);
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (match.test(entry.name)) found.push(child);
    }
  };
  for (const path of paths) await visit(path);
  return found.sort();
}

function skippedResult(item: RegisteredTest): TestResult {
  return { title: item.title, file: item.file, status: "skipped", durationMs: 0, attempts: [] };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) await onTimeout?.();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class Reporter {
  constructor(private readonly kind: "line" | "dot" | "json") {}

  start(total: number, workers: number): void {
    if (this.kind === "line")
      process.stdout.write(`Ryzer running ${total} tests with ${workers} workers\n\n`);
  }

  test(result: TestResult): void {
    if (this.kind === "json") return;
    const mark = result.cached
      ? "↻"
      : result.status === "passed"
        ? "✓"
        : result.status === "skipped"
          ? "-"
          : result.status === "flaky"
            ? "~"
            : "✗";
    if (this.kind === "dot") {
      process.stdout.write(mark);
      return;
    }
    const location = relative(process.cwd(), result.file);
    process.stdout.write(
      `${mark} ${location} › ${result.title} (${result.cached ? "native capsule" : `${result.durationMs.toFixed(0)}ms`})\n`,
    );
    if (result.status === "failed") {
      const error = result.attempts.at(-1)?.error ?? "Unknown error";
      process.stdout.write(`${indent(error)}\n`);
    }
  }

  end(summary: RunSummary): void {
    if (this.kind === "json") {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    if (this.kind === "dot") process.stdout.write("\n");
    const counts = summary.counts;
    process.stdout.write(
      `\n${counts.passed} passed, ${counts.failed} failed, ${counts.flaky} flaky, ${counts.skipped} skipped, ${counts.cached} native-cached in ${(summary.durationMs / 1_000).toFixed(2)}s\n`,
    );
  }
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
