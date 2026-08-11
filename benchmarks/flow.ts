import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CASES, STEPS } from "./shared.js";

type Framework = "ryzer-flow" | "ryzer-classic" | "playwright";
interface Sample {
  framework: Framework;
  durationMs: number;
  failed: number;
  exitCode: number;
}

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
const iterations = Number(process.env.FLOW_ITERATIONS ?? 5);
const warmups = Number(process.env.FLOW_WARMUPS ?? 1);
const workers = Number(process.env.FLOW_WORKERS ?? 4);
await mkdir(outputDir, { recursive: true });

for (let index = 0; index < warmups; index++) {
  await execute("ryzer-flow");
  await execute("ryzer-classic");
  await execute("playwright");
}

const samples: Sample[] = [];
const orders: Framework[][] = [
  ["ryzer-flow", "playwright", "ryzer-classic"],
  ["playwright", "ryzer-classic", "ryzer-flow"],
  ["ryzer-classic", "ryzer-flow", "playwright"],
];
process.stdout.write(
  `Compiled-flow benchmark: ${CASES} tests x ${STEPS} steps, ${workers} workers, ${iterations} measured runs\n`,
);
for (let index = 0; index < iterations; index++) {
  for (const framework of orders[index % orders.length]!) {
    const sample = await execute(framework);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${framework.padEnd(14)} ${(sample.durationMs / 1_000).toFixed(3)}s, ${sample.failed} failed\n`,
    );
  }
}

const flow = summarize(samples.filter((sample) => sample.framework === "ryzer-flow"));
const classic = summarize(samples.filter((sample) => sample.framework === "ryzer-classic"));
const playwright = summarize(samples.filter((sample) => sample.framework === "playwright"));
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    workers,
    cases: CASES,
    steps: STEPS,
  },
  flow,
  classic,
  playwright,
  flowVsClassic: classic.medianMs / flow.medianMs,
  flowVsPlaywright: playwright.medianMs / flow.medianMs,
  samples,
};
await writeFile(resolve(outputDir, "flow.json"), JSON.stringify(report, null, 2));
await writeFile(
  resolve(outputDir, "flow.md"),
  `# Compiled browser-transaction benchmark\n\n` +
    `Same ${CASES} tests and ${STEPS} steps, comparing compiled Ryzer Flow IR, imperative Ryzer, and Playwright.\n\n` +
    `| Runner | Median | p95 | Failed |\n|---|---:|---:|---:|\n` +
    `| Ryzer Flow | ${(flow.medianMs / 1_000).toFixed(3)}s | ${(flow.p95Ms / 1_000).toFixed(3)}s | ${flow.failed} |\n` +
    `| Ryzer classic | ${(classic.medianMs / 1_000).toFixed(3)}s | ${(classic.p95Ms / 1_000).toFixed(3)}s | ${classic.failed} |\n` +
    `| Playwright | ${(playwright.medianMs / 1_000).toFixed(3)}s | ${(playwright.p95Ms / 1_000).toFixed(3)}s | ${playwright.failed} |\n\n` +
    `Flow speedup: **${report.flowVsClassic.toFixed(2)}x vs imperative Ryzer**, ` +
    `**${report.flowVsPlaywright.toFixed(2)}x vs Playwright**.\n`,
);
process.stdout.write(
  `\nFlow ${report.flowVsClassic.toFixed(2)}x vs classic Ryzer; ${report.flowVsPlaywright.toFixed(2)}x vs Playwright\n`,
);
if (samples.some((sample) => sample.exitCode !== 0 || sample.failed !== 0)) process.exitCode = 1;

async function execute(framework: Framework): Promise<Sample> {
  const resultDir = resolve(outputDir, framework);
  const args =
    framework === "playwright"
      ? [
          resolve(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          resolve(root, "benchmarks/playwright.config.ts"),
          "--workers",
          String(workers),
        ]
      : [
          resolve(root, "dist/cli.js"),
          "test",
          resolve(
            root,
            framework === "ryzer-flow"
              ? "benchmarks/ryzer.flow.bench.spec.ts"
              : "benchmarks/ryzer.bench.spec.ts",
          ),
          "--workers",
          String(workers),
          "--reporter",
          "json",
          "--output",
          resultDir,
        ];
  const started = performance.now();
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "ignore" });
    child.on("exit", (code) => done(code ?? 1));
  });
  let failed = exitCode === 0 ? 0 : CASES;
  try {
    if (framework === "playwright") {
      const parsed = JSON.parse(
        await readFile(
          resolve(root, "benchmarks/benchmark-results/playwright-latest.json"),
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
    failed = CASES;
  }
  return { framework, durationMs: performance.now() - started, failed, exitCode };
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
  return (
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ??
    Number.NaN
  );
}
