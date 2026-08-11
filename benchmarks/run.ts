import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CASES, STEPS } from "./shared.js";

type Framework = "ryzer" | "playwright";
interface Sample {
  framework: Framework;
  durationMs: number;
  exitCode: number;
  failed: number;
}

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
const iterations = Number(process.env.BENCH_ITERATIONS ?? 5);
const warmups = Number(process.env.BENCH_WARMUPS ?? 1);
const ryzerMode = process.env.BENCH_RYZER_MODE === "cold" ? "cold" : "warm";
await mkdir(outputDir, { recursive: true });

process.stdout.write(
  `Benchmarking ${CASES} equivalent tests × ${STEPS} transaction steps, 4 workers, ${iterations} measured iterations\n`,
);
for (let index = 0; index < warmups; index++) {
  process.stdout.write(`warmup ${index + 1}/${warmups}\n`);
  await execute("ryzer", false);
  await execute("playwright", false);
}

const samples: Sample[] = [];
for (let index = 0; index < iterations; index++) {
  const order: Framework[] = index % 2 === 0 ? ["ryzer", "playwright"] : ["playwright", "ryzer"];
  for (const framework of order) {
    const sample = await execute(framework, true);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${framework.padEnd(10)} ${(sample.durationMs / 1_000).toFixed(3)}s, ${sample.failed} failed\n`,
    );
  }
}

const ryzer = summarize(samples.filter((sample) => sample.framework === "ryzer"));
const playwright = summarize(samples.filter((sample) => sample.framework === "playwright"));
const speedup = playwright.medianMs / ryzer.medianMs;
const fasterPercent = (speedup - 1) * 100;
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    workers: 4,
    cases: CASES,
    steps: STEPS,
    ryzerMode,
  },
  acceptance: { minimumSpeedup: 1.5, maximumRelativeFlakeRate: 0.5 },
  ryzer,
  playwright,
  speedup,
  fasterPercent,
  passedSpeedTarget: speedup >= 1.5,
  samples,
};
const reportBase = `benchmark-${ryzerMode}`;
await Promise.all([
  writeFile(resolve(outputDir, `${reportBase}.json`), JSON.stringify(report, null, 2)),
  writeFile(resolve(outputDir, "benchmark.json"), JSON.stringify(report, null, 2)),
]);
const markdown =
  `# Ryzer benchmark\n\n` +
  `Mode: **${ryzerMode}**. Same ${CASES} tests with ${STEPS} transaction steps each, same Chrome executable, same four workers, ${iterations} alternating measured runs after ${warmups} warmup.\n\n` +
  `| Runner | Median | p95 | Failed tests |\n|---|---:|---:|---:|\n` +
  `| Ryzer | ${(ryzer.medianMs / 1_000).toFixed(3)}s | ${(ryzer.p95Ms / 1_000).toFixed(3)}s | ${ryzer.failed} |\n` +
  `| Playwright | ${(playwright.medianMs / 1_000).toFixed(3)}s | ${(playwright.p95Ms / 1_000).toFixed(3)}s | ${playwright.failed} |\n\n` +
  `Ryzer speedup: **${speedup.toFixed(2)}x** (${fasterPercent.toFixed(1)}% higher throughput). Target: ${speedup >= 1.5 ? "PASS" : "FAIL"}.\n`;
await Promise.all([
  writeFile(resolve(outputDir, `${reportBase}.md`), markdown),
  writeFile(resolve(outputDir, "benchmark.md"), markdown),
]);
process.stdout.write(
  `\nRyzer median ${(ryzer.medianMs / 1_000).toFixed(3)}s; Playwright median ${(playwright.medianMs / 1_000).toFixed(3)}s\n`,
);
process.stdout.write(
  `Speedup ${speedup.toFixed(2)}x (${fasterPercent.toFixed(1)}% faster): ${speedup >= 1.5 ? "PASS" : "FAIL"}\n`,
);
if (ryzer.failed || playwright.failed) process.exitCode = 1;

async function execute(framework: Framework, measured: boolean): Promise<Sample> {
  const ryzerOutput = resolve(outputDir, "ryzer-latest");
  const command = process.execPath;
  const args =
    framework === "ryzer"
      ? [
          resolve(root, "dist/cli.js"),
          "test",
          resolve(root, "benchmarks/ryzer.bench.spec.ts"),
          "--workers",
          "4",
          "--reporter",
          "json",
          "--output",
          ryzerOutput,
        ]
      : [
          resolve(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          resolve(root, "benchmarks/playwright.config.ts"),
        ];
  const started = performance.now();
  const result = await new Promise<{ exitCode: number; output: string }>((done) => {
    const env = {
      ...process.env,
      ...(framework === "ryzer" && ryzerMode === "cold" ? { RYZER_DISABLE_DAEMON: "1" } : {}),
    };
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => done({ exitCode: code ?? 1, output }));
  });
  const durationMs = performance.now() - started;
  let failed = result.exitCode === 0 ? 0 : CASES;
  try {
    if (framework === "ryzer") {
      const parsed = JSON.parse(await readFile(resolve(ryzerOutput, "results.json"), "utf8")) as {
        counts: { failed: number };
      };
      failed = parsed.counts.failed;
    } else {
      const parsed = JSON.parse(
        await readFile(
          resolve(root, "benchmarks/benchmark-results/playwright-latest.json"),
          "utf8",
        ),
      ) as {
        stats?: { unexpected?: number };
      };
      failed = parsed.stats?.unexpected ?? failed;
    }
  } catch {
    if (measured)
      process.stderr.write(`${framework} result parsing failed\n${result.output.slice(-2_000)}\n`);
  }
  if (result.exitCode !== 0 && measured)
    process.stderr.write(`${framework} failed\n${result.output.slice(-4_000)}\n`);
  return { framework, durationMs, exitCode: result.exitCode, failed };
}

function summarize(samples: Sample[]): {
  medianMs: number;
  p95Ms: number;
  failed: number;
  runs: number;
} {
  const values = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    failed: samples.reduce((sum, sample) => sum + sample.failed, 0),
    runs: samples.length,
  };
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return Number.NaN;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? Number.NaN;
}
