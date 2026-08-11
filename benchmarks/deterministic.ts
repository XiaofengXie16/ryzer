import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DETERMINISTIC_CASES, TIMER_DELAY_MS } from "./deterministic-shared.js";

type Framework = "flow-virtual" | "ryzer-real" | "playwright-clock" | "playwright-real";
interface Sample {
  framework: Framework;
  durationMs: number;
  failed: number;
  exitCode: number;
}

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
const iterations = Number(process.env.DETERMINISTIC_ITERATIONS ?? 5);
await mkdir(outputDir, { recursive: true });
for (const framework of [
  "flow-virtual",
  "ryzer-real",
  "playwright-clock",
  "playwright-real",
] as const)
  await execute(framework);

const samples: Sample[] = [];
const orders: Framework[][] = [
  ["flow-virtual", "playwright-clock", "ryzer-real", "playwright-real"],
  ["playwright-clock", "ryzer-real", "playwright-real", "flow-virtual"],
  ["ryzer-real", "playwright-real", "flow-virtual", "playwright-clock"],
  ["playwright-real", "flow-virtual", "playwright-clock", "ryzer-real"],
];
process.stdout.write(
  `Deterministic-time benchmark: ${DETERMINISTIC_CASES} tests with ${TIMER_DELAY_MS}ms app timers, ${iterations} runs\n`,
);
for (let index = 0; index < iterations; index++) {
  for (const framework of orders[index % orders.length]!) {
    const sample = await execute(framework);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${framework.padEnd(18)} ${(sample.durationMs / 1_000).toFixed(3)}s, ${sample.failed} failed\n`,
    );
  }
}

const flow = summarize("flow-virtual");
const ryzer = summarize("ryzer-real");
const playwrightClock = summarize("playwright-clock");
const playwrightReal = summarize("playwright-real");
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cases: DETERMINISTIC_CASES,
    timerDelayMs: TIMER_DELAY_MS,
  },
  flow,
  ryzer,
  playwrightClock,
  playwrightReal,
  flowVsRyzer: ryzer.medianMs / flow.medianMs,
  flowVsPlaywrightClock: playwrightClock.medianMs / flow.medianMs,
  flowVsPlaywrightReal: playwrightReal.medianMs / flow.medianMs,
  samples,
};
await writeFile(resolve(outputDir, "deterministic.json"), JSON.stringify(report, null, 2));
await writeFile(
  resolve(outputDir, "deterministic.md"),
  `# Deterministic virtual-time benchmark\n\n` +
    `${DETERMINISTIC_CASES} matched tests, each containing a real trusted click and a ${TIMER_DELAY_MS}ms application timer. ` +
    `Flow advances Chrome's synthetic clock. The strongest matched Playwright lane uses Playwright's installed clock; real-time lanes show the benefit of virtualizing application time.\n\n` +
    `| Runner | Median | p95 | Failed |\n|---|---:|---:|---:|\n` +
    `| Ryzer Flow virtual time | ${(flow.medianMs / 1_000).toFixed(3)}s | ${(flow.p95Ms / 1_000).toFixed(3)}s | ${flow.failed} |\n` +
    `| Playwright virtual clock | ${(playwrightClock.medianMs / 1_000).toFixed(3)}s | ${(playwrightClock.p95Ms / 1_000).toFixed(3)}s | ${playwrightClock.failed} |\n` +
    `| Ryzer real time | ${(ryzer.medianMs / 1_000).toFixed(3)}s | ${(ryzer.p95Ms / 1_000).toFixed(3)}s | ${ryzer.failed} |\n` +
    `| Playwright real time | ${(playwrightReal.medianMs / 1_000).toFixed(3)}s | ${(playwrightReal.p95Ms / 1_000).toFixed(3)}s | ${playwrightReal.failed} |\n\n` +
    `Virtual-time Flow speedup: **${report.flowVsRyzer.toFixed(2)}x vs Ryzer**, ` +
    `**${report.flowVsPlaywrightClock.toFixed(2)}x vs Playwright clock**, and ` +
    `**${report.flowVsPlaywrightReal.toFixed(2)}x vs Playwright real time**.\n`,
);
process.stdout.write(
  `\nVirtual Flow ${report.flowVsRyzer.toFixed(2)}x vs Ryzer; ${report.flowVsPlaywrightClock.toFixed(2)}x vs Playwright clock; ${report.flowVsPlaywrightReal.toFixed(2)}x vs Playwright real time\n`,
);
if (samples.some((sample) => sample.exitCode !== 0 || sample.failed !== 0)) process.exitCode = 1;

async function execute(framework: Framework): Promise<Sample> {
  const resultDir = resolve(outputDir, framework);
  const isPlaywright = framework === "playwright-real" || framework === "playwright-clock";
  const args = isPlaywright
    ? [
        resolve(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        resolve(root, "benchmarks/playwright.deterministic.config.ts"),
      ]
    : [
        resolve(root, "dist/cli.js"),
        "test",
        resolve(
          root,
          framework === "flow-virtual"
            ? "benchmarks/ryzer.deterministic.flow.spec.ts"
            : "benchmarks/ryzer.deterministic.classic.spec.ts",
        ),
        "--workers",
        "4",
        "--reporter",
        "json",
        "--output",
        resultDir,
      ];
  const started = performance.now();
  const exitCode = await new Promise<number>((done) => {
    const env = framework === "playwright-clock" ? { ...process.env, PW_CLOCK: "1" } : process.env;
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
    child.on("exit", (code) => done(code ?? 1));
  });
  let failed = exitCode === 0 ? 0 : DETERMINISTIC_CASES;
  try {
    if (isPlaywright) {
      const parsed = JSON.parse(
        await readFile(
          resolve(root, "benchmarks/benchmark-results/playwright-deterministic.json"),
          "utf8",
        ),
      ) as {
        stats?: { unexpected?: number };
      };
      failed = parsed.stats?.unexpected ?? failed;
    } else {
      const parsed = JSON.parse(await readFile(resolve(resultDir, "results.json"), "utf8")) as {
        counts: { failed: number };
      };
      failed = parsed.counts.failed;
    }
  } catch {
    failed = DETERMINISTIC_CASES;
  }
  return { framework, durationMs: performance.now() - started, failed, exitCode };
}

function summarize(framework: Framework): {
  medianMs: number;
  p95Ms: number;
  failed: number;
  runs: number;
} {
  const selected = samples.filter((sample) => sample.framework === framework);
  const values = selected.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    failed: selected.reduce((sum, sample) => sum + sample.failed, 0),
    runs: selected.length,
  };
}

function percentile(values: number[], quantile: number): number {
  return (
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ??
    Number.NaN
  );
}
