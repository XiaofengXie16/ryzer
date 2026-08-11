import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RyzerSample {
  wallMs: number;
  internalMs: number;
  failed: number;
  cached: number;
  executed: number;
  runtime: string;
}

interface PlaywrightSample {
  wallMs: number;
  failed: number;
}

const root = resolve(import.meta.dirname, "..");
const workRoot = resolve(root, "work");
const outputDir = resolve(root, "benchmark-results/incremental");
const template = resolve(root, "benchmarks/incremental-fixture");
const iterations = Number(process.env.INCREMENTAL_ITERATIONS ?? 3);
const workers = Number(process.env.INCREMENTAL_WORKERS ?? 8);
await mkdir(workRoot, { recursive: true });
await mkdir(outputDir, { recursive: true });
const project = await mkdtemp(join(workRoot, "incremental-bench-"));

try {
  await cp(template, project, { recursive: true });
  process.stdout.write(
    `Incremental benchmark: 64 tests, ${workers} workers, ${iterations} full-run samples\n`,
  );

  await runRyzer(["--no-incremental"]);
  await runPlaywright(-1);
  process.stdout.write("Warmup complete\n");

  const ryzerFull: RyzerSample[] = [];
  const playwrightFull: PlaywrightSample[] = [];
  for (let index = 0; index < iterations; index++) {
    const ryzer = await runRyzer(["--no-incremental"]);
    ryzerFull.push(ryzer);
    process.stdout.write(
      `${index + 1}/${iterations} Ryzer full       ${(ryzer.wallMs / 1_000).toFixed(3)}s\n`,
    );
    const playwright = await runPlaywright(index);
    playwrightFull.push(playwright);
    process.stdout.write(
      `${index + 1}/${iterations} Playwright full  ${(playwright.wallMs / 1_000).toFixed(3)}s\n`,
    );
  }

  const seed = await runRyzer(["--incremental"]);
  if (seed.failed !== 0 || seed.cached !== 0 || seed.executed !== 64)
    throw new Error("incremental seed did not execute all 64 tests");
  const unchanged: RyzerSample[] = [];
  for (let index = 0; index < 5; index++) unchanged.push(await runRyzer(["--incremental"]));
  if (
    unchanged.some(
      (sample) =>
        sample.failed !== 0 ||
        sample.cached !== 64 ||
        sample.executed !== 0 ||
        sample.runtime !== "native-capsule",
    )
  ) {
    throw new Error("unchanged run did not replay all 64 tests from the native capsule");
  }

  await appendFile(
    resolve(project, "tests/group-a-data.ts"),
    "\n// dependency-scoped benchmark revision\n",
  );
  const partial = await runRyzer(["--incremental"]);
  if (partial.failed !== 0 || partial.cached !== 48 || partial.executed !== 16) {
    throw new Error(`partial run selected the wrong work: ${JSON.stringify(partial)}`);
  }

  const ryzer = summarize(ryzerFull.map((sample) => sample.wallMs));
  const playwright = summarize(playwrightFull.map((sample) => sample.wallMs));
  const unchangedSummary = summarize(unchanged.map((sample) => sample.wallMs));
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      workers,
      tests: 64,
      affectedTests: 16,
      excludedWarmups: 1,
    },
    ryzerFull: { ...ryzer, failed: ryzerFull.reduce((sum, sample) => sum + sample.failed, 0) },
    playwrightFull: {
      ...playwright,
      failed: playwrightFull.reduce((sum, sample) => sum + sample.failed, 0),
    },
    unchanged: {
      ...unchangedSummary,
      internalMedianMs: median(unchanged.map((sample) => sample.internalMs)),
      cached: 64,
    },
    partial: {
      wallMs: partial.wallMs,
      internalMs: partial.internalMs,
      cached: partial.cached,
      executed: partial.executed,
    },
    speedups: {
      unchangedVsRyzerFull: ryzer.medianMs / unchangedSummary.medianMs,
      unchangedVsPlaywright: playwright.medianMs / unchangedSummary.medianMs,
      partialVsRyzerFull: ryzer.medianMs / partial.wallMs,
      partialVsPlaywright: playwright.medianMs / partial.wallMs,
    },
    samples: { ryzerFull, playwrightFull, seed, unchanged, partial },
  };
  await writeFile(resolve(outputDir, "incremental.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(outputDir, "incremental.md"),
    `# Native incremental execution benchmark\n\n` +
      `Same 64 browser tests with one excluded warmup per runner. A partial edit affects 16 tests; 48 remain replayable. Times include process startup.\n\n` +
      `| Path | Median / run | Browser tests executed | Native-cached |\n|---|---:|---:|---:|\n` +
      `| Playwright full | ${(playwright.medianMs / 1_000).toFixed(3)}s | 64 | 0 |\n` +
      `| Ryzer full | ${(ryzer.medianMs / 1_000).toFixed(3)}s | 64 | 0 |\n` +
      `| Ryzer unchanged | ${(unchangedSummary.medianMs / 1_000).toFixed(3)}s | 0 | 64 |\n` +
      `| Ryzer partial edit | ${(partial.wallMs / 1_000).toFixed(3)}s | 16 | 48 |\n\n` +
      `Unchanged speedup: **${report.speedups.unchangedVsPlaywright.toFixed(2)}x vs Playwright** and ` +
      `**${report.speedups.unchangedVsRyzerFull.toFixed(2)}x vs full Ryzer**. Partial-edit speedup: ` +
      `**${report.speedups.partialVsPlaywright.toFixed(2)}x vs Playwright**.\n`,
  );
  process.stdout.write(
    `\nUnchanged ${report.speedups.unchangedVsPlaywright.toFixed(2)}x vs Playwright; ` +
      `partial ${report.speedups.partialVsPlaywright.toFixed(2)}x vs Playwright\n`,
  );
  if (report.ryzerFull.failed || report.playwrightFull.failed) process.exitCode = 1;
} finally {
  await rm(project, { recursive: true, force: true });
}

async function runRyzer(extra: string[]): Promise<RyzerSample> {
  const args = [
    resolve(root, "dist/cli.js"),
    "test",
    "tests/ryzer-a.spec.ts",
    "tests/ryzer-b.spec.ts",
    "--workers",
    String(workers),
    "--reporter",
    "json",
    "--output",
    "ryzer-results",
    ...extra,
  ];
  const started = performance.now();
  const result = await run(process.execPath, args, project);
  const wallMs = performance.now() - started;
  const line = result.stdout.trim().split("\n").at(-1);
  if (result.code !== 0 || !line)
    throw new Error(`Ryzer benchmark failed (${result.code}): ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(line) as {
    durationMs: number;
    runtime: string;
    counts: { failed: number; cached: number };
    capsule?: { executed: number };
  };
  return {
    wallMs,
    internalMs: parsed.durationMs,
    failed: parsed.counts.failed,
    cached: parsed.counts.cached,
    executed: parsed.capsule?.executed ?? 64,
    runtime: parsed.runtime,
  };
}

async function runPlaywright(index: number): Promise<PlaywrightSample> {
  const resultFile = resolve(project, `playwright-${index}.json`);
  const args = [
    resolve(root, "node_modules/@playwright/test/cli.js"),
    "test",
    "--config",
    resolve(project, "playwright.config.ts"),
    "--workers",
    String(workers),
  ];
  const started = performance.now();
  const result = await run(process.execPath, args, project, { INCREMENTAL_PW_OUTPUT: resultFile });
  const wallMs = performance.now() - started;
  if (result.code !== 0)
    throw new Error(
      `Playwright benchmark failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  const parsed = JSON.parse(await readFile(resultFile, "utf8")) as {
    stats?: { unexpected?: number };
  };
  return { wallMs, failed: parsed.stats?.unexpected ?? 0 };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

function summarize(values: number[]): { medianMs: number; p95Ms: number; runs: number } {
  return { medianMs: median(values), p95Ms: percentile(values, 0.95), runs: values.length };
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ??
    Number.NaN
  );
}
