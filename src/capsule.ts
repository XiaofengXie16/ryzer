import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveChromeExecutable } from "./browser.js";
import { fingerprintProject, type ProjectFingerprint } from "./native.js";
import type { RegisteredTest } from "./test.js";
import type { RunnerConfig } from "./types.js";

// 4: symlink digests written by versions before the Sha256::update fix were a
// function of the target's length alone, so a same-length retarget could not
// invalidate a cached result.
const CACHE_VERSION = 4;

interface CachedTest {
  file: string;
  title: string;
  dependencies: string[];
  durationMs: number;
  hermetic: true;
}

interface CapsuleCache {
  version: number;
  environment: string;
  fingerprint: ProjectFingerprint;
  tests: Record<string, CachedTest>;
  runs: Record<string, CachedRun>;
}

interface CachedRun {
  results: Array<{
    title: string;
    file: string;
    status: "passed" | "skipped";
    sourceDurationMs: number;
  }>;
}

export interface CapsulePreflight {
  cachePath: string;
  root: string;
  fingerprint: ProjectFingerprint;
  environment: string;
  previous?: CapsuleCache;
  runKey: string;
  excludes: string[];
}

export interface CompleteCapsuleReplay {
  results: CachedRun["results"];
  stats: CapsuleStats;
}

interface TestInfo {
  key: string;
  dependencies: Set<string>;
  staticSafe: boolean;
}

export interface CapsuleObservation {
  hermetic: boolean;
  resources: string[];
  reasons: string[];
}

export interface CapsuleStats {
  enabled: true;
  reused: number;
  executed: number;
  invalidation: string;
  engine: ProjectFingerprint["engine"];
}

export class CapsuleSession {
  readonly reusable = new Map<number, CachedTest>();
  readonly stats: CapsuleStats;
  readonly #cachePath: string;
  readonly #root: string;
  readonly #fingerprint: ProjectFingerprint;
  readonly #environment: string;
  readonly #infos = new Map<number, TestInfo>();
  readonly #nextTests: Record<string, CachedTest> = {};
  readonly #nextRuns: Record<string, CachedRun> = {};
  readonly #runKey: string;
  readonly #excludes: string[];

  private constructor(options: {
    cachePath: string;
    root: string;
    fingerprint: ProjectFingerprint;
    environment: string;
    stats: CapsuleStats;
    runKey: string;
    excludes: string[];
  }) {
    this.#cachePath = options.cachePath;
    this.#root = options.root;
    this.#fingerprint = options.fingerprint;
    this.#environment = options.environment;
    this.stats = options.stats;
    this.#runKey = options.runKey;
    this.#excludes = options.excludes;
  }

  static async create(
    config: RunnerConfig,
    tests: RegisteredTest[],
    prepared?: CapsulePreflight,
  ): Promise<CapsuleSession> {
    const preflight = prepared ?? (await prepareCapsule(config, []));
    const { cachePath, root, fingerprint, environment, previous, runKey, excludes } = preflight;
    const stats: CapsuleStats = {
      enabled: true,
      reused: 0,
      executed: 0,
      invalidation: "first run",
      engine: fingerprint.engine,
    };
    const session = new CapsuleSession({
      cachePath,
      root,
      fingerprint,
      environment,
      stats,
      runKey,
      excludes,
    });
    const occurrences = new Map<string, number>();
    for (const test of tests) {
      const relativeFile = normalizePath(relative(root, test.file));
      const base = `${relativeFile}\u0000${test.title}`;
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const analysis = await analyzeDependencies(test.file, root);
      session.#infos.set(test.id, {
        key: `${base}\u0000${occurrence}`,
        dependencies: analysis.dependencies,
        staticSafe: analysis.safe && test.beforeEach.length === 0 && test.afterEach.length === 0,
      });
    }

    if (!previous || previous.version !== CACHE_VERSION) return session;
    if (previous.environment !== environment) {
      stats.invalidation = "runtime or browser configuration changed";
      return session;
    }
    if (previous.fingerprint.engine !== fingerprint.engine) {
      stats.invalidation = "fingerprint engine changed";
      return session;
    }
    const changed = changedFiles(previous.fingerprint.files, fingerprint.files);
    const known = new Set<string>();
    for (const cached of Object.values(previous.tests))
      for (const dependency of cached.dependencies) known.add(dependency);
    for (const info of session.#infos.values())
      for (const dependency of info.dependencies) known.add(dependency);
    const unknown = [...changed].filter((path) => !known.has(path));
    if (unknown.length > 0) {
      stats.invalidation = `unknown project changes (${unknown.slice(0, 3).join(", ")})`;
      return session;
    }
    stats.invalidation =
      changed.size === 0 ? "no project changes" : `${changed.size} mapped file change(s)`;
    if (changed.size === 0) Object.assign(session.#nextRuns, previous.runs ?? {});
    // A filtered run must not erase valid capsules for tests it did not
    // select. Carry every unaffected record forward, then let selected tests
    // either reuse, replace, or explicitly remove their own record.
    for (const [key, cached] of Object.entries(previous.tests)) {
      if (!cached.dependencies.some((dependency) => changed.has(dependency))) {
        session.#nextTests[key] = cached;
      }
    }
    for (const test of tests) {
      const info = session.#infos.get(test.id)!;
      const cached = previous.tests[info.key];
      delete session.#nextTests[info.key];
      if (!cached || !info.staticSafe || cached.hermetic !== true) continue;
      if (cached.dependencies.some((dependency) => changed.has(dependency))) continue;
      session.reusable.set(test.id, cached);
      session.#nextTests[info.key] = cached;
    }
    // Selection is closed over the static dependency graph. If any test in a
    // module component must execute, every test sharing that component also
    // executes. This preserves test-file and imported-module state instead of
    // letting a skipped body silently change a later test's inputs.
    const activeDependencies = new Set<string>();
    for (const test of tests) {
      if (test.skipped || session.reusable.has(test.id)) continue;
      for (const dependency of session.#infos.get(test.id)?.dependencies ?? [])
        activeDependencies.add(dependency);
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const test of tests) {
        if (!session.reusable.has(test.id)) continue;
        const dependencies = session.#infos.get(test.id)?.dependencies ?? new Set<string>();
        if (![...dependencies].some((dependency) => activeDependencies.has(dependency))) continue;
        session.reusable.delete(test.id);
        const key = session.#infos.get(test.id)?.key;
        if (key) delete session.#nextTests[key];
        for (const dependency of dependencies) activeDependencies.add(dependency);
        expanded = true;
      }
    }
    stats.reused = session.reusable.size;
    return session;
  }

  cachedResult(test: RegisteredTest): { durationMs: number; dependencies: string[] } | undefined {
    const cached = this.reusable.get(test.id);
    return cached
      ? { durationMs: cached.durationMs, dependencies: cached.dependencies }
      : undefined;
  }

  async record(
    test: RegisteredTest,
    result: { status: string; durationMs: number },
    observation: CapsuleObservation | undefined,
  ): Promise<void> {
    this.stats.executed++;
    const info = this.#infos.get(test.id);
    if (!info) return;
    delete this.#nextTests[info.key];
    if (!info.staticSafe || result.status !== "passed" || !observation?.hermetic) return;
    const dependencies = new Set(info.dependencies);
    for (const resource of observation.resources) {
      const mapped = mapResourceToProject(resource, this.#root);
      let protocol: string | undefined;
      try {
        protocol = new URL(resource).protocol;
      } catch {
        return;
      }
      if (protocol === "file:" && !mapped) return;
      if (!mapped) continue;
      const analysis = await analyzeDependencies(resolve(this.#root, mapped), this.#root);
      if (!analysis.safe) return;
      for (const dependency of analysis.dependencies) dependencies.add(dependency);
    }
    this.#nextTests[info.key] = {
      file: normalizePath(relative(this.#root, test.file)),
      title: test.title,
      dependencies: [...dependencies].sort(),
      durationMs: result.durationMs,
      hermetic: true,
    };
  }

  finalize(
    tests: RegisteredTest[],
    results: Array<{ status: string; cacheSourceDurationMs?: number; durationMs: number }>,
  ): void {
    const complete = tests.every((test, index) => {
      const result = results[index];
      if (!result) return false;
      if (test.skipped) return result.status === "skipped";
      const info = this.#infos.get(test.id);
      return result.status === "passed" && Boolean(info && this.#nextTests[info.key]);
    });
    if (!complete) {
      delete this.#nextRuns[this.#runKey];
      return;
    }
    this.#nextRuns[this.#runKey] = {
      results: tests.map((test, index) => ({
        title: test.title,
        file: normalizePath(relative(this.#root, test.file)),
        status: test.skipped ? "skipped" : "passed",
        sourceDurationMs: results[index]?.cacheSourceDurationMs ?? results[index]?.durationMs ?? 0,
      })),
    };
  }

  async save(): Promise<void> {
    const current = await fingerprintProject(this.#root, this.#excludes);
    if (
      current.engine !== this.#fingerprint.engine ||
      changedFiles(this.#fingerprint.files, current.files).size > 0
    ) {
      this.stats.invalidation = "project changed while tests were running; capsule not saved";
      return;
    }
    await mkdir(dirname(this.#cachePath), { recursive: true });
    const temporary = `${this.#cachePath}.${process.pid}.${randomUUID()}.tmp`;
    const cache: CapsuleCache = {
      version: CACHE_VERSION,
      environment: this.#environment,
      fingerprint: this.#fingerprint,
      tests: this.#nextTests,
      runs: this.#nextRuns,
    };
    await writeFile(temporary, `${JSON.stringify(cache)}\n`);
    await rename(temporary, this.#cachePath);
  }
}

export async function prepareCapsule(
  config: RunnerConfig,
  explicitPaths: string[],
): Promise<CapsulePreflight> {
  const root = resolve(config.projectRoot ?? process.cwd());
  const cacheDir = resolve(root, config.incrementalCacheDir ?? ".ryzer");
  if (cacheDir === root) throw new Error("incrementalCacheDir cannot be the project root");
  const cachePath = join(cacheDir, `capsules-v${CACHE_VERSION}.json`);
  const output = resolve(config.outputDir ?? "ryzer-results");
  const excludes = [
    relativeIfInside(root, cacheDir),
    relativeIfInside(root, output),
    ...(config.incrementalExcludes ?? []),
  ].filter((value): value is string => Boolean(value));
  const [fingerprint, environment, previous] = await Promise.all([
    fingerprintProject(root, excludes),
    environmentSignature(config),
    readCache(cachePath),
  ]);
  return {
    cachePath,
    root,
    fingerprint,
    environment,
    previous,
    runKey: requestKey(config, explicitPaths, root),
    excludes,
  };
}

export function replayCompleteCapsule(
  preflight: CapsulePreflight,
): CompleteCapsuleReplay | undefined {
  const { previous, fingerprint, environment, runKey } = preflight;
  if (!previous || previous.version !== CACHE_VERSION || previous.environment !== environment)
    return undefined;
  if (previous.fingerprint.engine !== fingerprint.engine) return undefined;
  if (changedFiles(previous.fingerprint.files, fingerprint.files).size !== 0) return undefined;
  const run = previous.runs?.[runKey];
  if (!run) return undefined;
  const reused = run.results.filter((result) => result.status === "passed").length;
  return {
    results: run.results,
    stats: {
      enabled: true,
      reused,
      executed: 0,
      invalidation: "no project changes; complete run replayed before test loading",
      engine: fingerprint.engine,
    },
  };
}

async function environmentSignature(config: RunnerConfig): Promise<string> {
  const executable = await resolveChromeExecutable(config.executablePath);
  const metadata = await stat(executable);
  return JSON.stringify({
    schema: CACHE_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    chrome: { path: executable, size: metadata.size, modifiedMs: metadata.mtimeMs },
    launch: {
      headless: config.headless !== false,
      args: config.args ?? [],
      viewport: config.viewport ?? { width: 1280, height: 720, deviceScaleFactor: 1 },
      isolation: config.isolation ?? "reset",
      testIdAttribute: config.testIdAttribute ?? "data-testid",
      baseURL: config.baseURL,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 5_000,
      defaultNavigationTimeoutMs: config.defaultNavigationTimeoutMs ?? 15_000,
      testTimeoutMs: config.timeoutMs ?? 30_000,
      retries: config.retries ?? 0,
      env: config.env ? digest(stableObject(config.env)) : undefined,
      ambient: digest(
        stableObject(
          Object.fromEntries(
            ["LANG", "LC_ALL", "LC_CTYPE", "TZ"].map((key) => [key, process.env[key]]),
          ),
        ),
      ),
    },
  });
}

function requestKey(config: RunnerConfig, explicitPaths: string[], root: string): string {
  const requested = (explicitPaths.length ? explicitPaths : [config.testDir ?? "tests"])
    .map((path) => normalizePath(relative(root, resolve(path))))
    .sort();
  return JSON.stringify({
    requested,
    match: config.match ? { source: config.match.source, flags: config.match.flags } : undefined,
  });
}

function stableObject(value: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readCache(path: string): Promise<CapsuleCache | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isCapsuleCache(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isCapsuleCache(value: unknown): value is CapsuleCache {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    typeof value.environment !== "string"
  )
    return false;
  if (
    !isRecord(value.fingerprint) ||
    !["native-sha256", "node-sha256"].includes(String(value.fingerprint.engine))
  )
    return false;
  if (!isStringRecord(value.fingerprint.files) || !isRecord(value.tests) || !isRecord(value.runs))
    return false;
  for (const cached of Object.values(value.tests)) {
    if (!isRecord(cached) || typeof cached.file !== "string" || typeof cached.title !== "string")
      return false;
    if (
      !Array.isArray(cached.dependencies) ||
      !cached.dependencies.every((item) => typeof item === "string")
    )
      return false;
    if (typeof cached.durationMs !== "number" || cached.hermetic !== true) return false;
  }
  for (const run of Object.values(value.runs)) {
    if (!isRecord(run) || !Array.isArray(run.results)) return false;
    for (const result of run.results) {
      if (!isRecord(result) || typeof result.title !== "string" || typeof result.file !== "string")
        return false;
      if (result.status !== "passed" && result.status !== "skipped") return false;
      if (typeof result.sourceDurationMs !== "number") return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function changedFiles(before: Record<string, string>, after: Record<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path]) changed.add(path);
  }
  return changed;
}

export async function analyzeDependencies(
  entry: string,
  root: string,
): Promise<{ dependencies: Set<string>; safe: boolean }> {
  const dependencies = new Set<string>();
  const visited = new Set<string>();
  const canonicalRoot = await realpath(root).catch(() => root);
  const engineRoots = [
    resolve(import.meta.dirname),
    resolve(import.meta.dirname, "../src"),
    resolve(import.meta.dirname, "../dist"),
  ];
  let safe = true;
  const visit = async (file: string): Promise<void> => {
    const absolute = resolve(file);
    if (visited.has(absolute) || engineRoots.some((engineRoot) => isInside(engineRoot, absolute)))
      return;
    visited.add(absolute);
    if (!isInside(root, absolute)) {
      safe = false;
      return;
    }
    const path = normalizePath(relative(root, absolute));
    dependencies.add(path);
    const canonical = await realpath(absolute).catch(() => undefined);
    if (!canonical || !isInside(canonicalRoot, canonical)) {
      safe = false;
      return;
    }
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch {
      safe = false;
      return;
    }
    if (hasUnsafeDynamicInput(source)) safe = false;
    for (const specifier of importSpecifiers(source)) {
      if (specifier === "ryzer" || specifier.startsWith("ryzer/")) continue;
      if (!specifier.startsWith(".") && !specifier.startsWith("file:")) {
        safe = false;
        continue;
      }
      const resolved = resolveImport(absolute, specifier);
      if (!resolved) {
        safe = false;
        continue;
      }
      await visit(resolved);
    }
  };
  await visit(entry);
  return { dependencies, safe };
}

function importSpecifiers(source: string): string[] {
  const values: string[] = [];
  const pattern =
    /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) if (match[1]) values.push(match[1]);
  return values;
}

function resolveImport(importer: string, specifier: string): string | undefined {
  const raw = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : resolve(dirname(importer), specifier);
  const candidates = [raw];
  if (/\.[cm]?js$/.test(raw)) {
    const without = raw.replace(/\.[cm]?js$/, "");
    candidates.push(`${without}.ts`, `${without}.tsx`, `${without}.mts`, `${without}.cts`);
  }
  if (!/\.[a-z0-9]+$/i.test(raw)) {
    for (const extension of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"])
      candidates.push(`${raw}${extension}`);
    for (const extension of [".ts", ".tsx", ".js", ".mjs", ".cjs"])
      candidates.push(join(raw, `index${extension}`));
  }
  return candidates.find(isFile);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasUnsafeDynamicInput(source: string): boolean {
  const executable = maskLiteralsAndComments(source);
  const unsafeExecutable =
    /\b(?:process|Deno|Bun|WebSocket|EventSource|globalThis|global|navigator|Intl|Math|Date|performance|crypto|fetch|setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask|eval|require|__dirname|__filename)\b|\bnew\s+Function\b|\bimport\.meta\b/.test(
      executable,
    );
  if (unsafeExecutable || /\bimport\s*\(\s*[^"']/.test(source)) return true;
  // Browser programs embedded in HTML/template strings are not visible in
  // the surrounding TypeScript token stream. Recognize high-signal ambient
  // inputs without treating ordinary prose in test titles as executable.
  return /\b(?:WebSocket|EventSource)\s*\(|\bnavigator\s*[.[]|\bIntl\s*[.(]|\bMath\.random\b|\bDate\.now\b|\bnew\s+Date\b|\bperformance\.now\b|\bcrypto\s*[.[]|\bfetch\s*\(|\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask|eval)\s*\(|\bnew\s+Function\b/.test(
    source,
  );
}

function maskLiteralsAndComments(source: string): string {
  const output = [...source];
  let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  const templateExpressions: number[] = [];
  for (let index = 0; index < output.length; index++) {
    const character = source[index]!;
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (character === "\n") mode = "code";
      else output[index] = " ";
      continue;
    }
    if (mode === "block-comment") {
      output[index] = " ";
      if (character === "*" && next === "/") {
        output[index + 1] = " ";
        index++;
        mode = "code";
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      output[index] = " ";
      if (character === "\\") {
        if (index + 1 < output.length) output[++index] = " ";
      } else if (
        (mode === "single" && character === "'") ||
        (mode === "double" && character === '"')
      ) {
        mode = "code";
      }
      continue;
    }
    if (mode === "template") {
      output[index] = " ";
      if (character === "\\") {
        if (index + 1 < output.length) output[++index] = " ";
      } else if (character === "`") {
        mode = "code";
      } else if (character === "$" && next === "{") {
        output[index + 1] = " ";
        index++;
        templateExpressions.push(1);
        mode = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      output[index] = output[index + 1] = " ";
      index++;
      mode = "line-comment";
    } else if (character === "/" && next === "*") {
      output[index] = output[index + 1] = " ";
      index++;
      mode = "block-comment";
    } else if (character === "'") {
      output[index] = " ";
      mode = "single";
    } else if (character === '"') {
      output[index] = " ";
      mode = "double";
    } else if (character === "`") {
      output[index] = " ";
      mode = "template";
    } else if (templateExpressions.length > 0 && character === "{") {
      templateExpressions[templateExpressions.length - 1]!++;
    } else if (templateExpressions.length > 0 && character === "}") {
      const last = templateExpressions.length - 1;
      templateExpressions[last]!--;
      if (templateExpressions[last] === 0) {
        templateExpressions.pop();
        output[index] = " ";
        mode = "template";
      }
    }
  }
  return output.join("");
}

function mapResourceToProject(resource: string, root: string): string | undefined {
  try {
    const url = new URL(resource);
    if (url.protocol !== "file:") return undefined;
    const file = fileURLToPath(url);
    return isInside(root, file) ? normalizePath(relative(root, file)) : undefined;
  } catch {
    return undefined;
  }
}

function relativeIfInside(root: string, value: string): string | undefined {
  return isInside(root, value) ? normalizePath(relative(root, value)) : undefined;
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function normalizePath(value: string): string {
  return value.split(sep).join("/");
}
