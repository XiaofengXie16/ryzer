import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Mode = "ryzer-warm" | "ryzer-cold" | "playwright";
interface Sample {
  mode: Mode;
  durationMs: number;
  exitCode: number;
  runtime?: "native-pool" | "direct";
}

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
const iterations = Number(process.env.OVERHEAD_ITERATIONS ?? 7);
await mkdir(outputDir, { recursive: true });
await execute("ryzer-warm");
await execute("ryzer-cold");
await execute("playwright");

const samples: Sample[] = [];
const orders: Mode[][] = [
  ["ryzer-warm", "playwright", "ryzer-cold"],
  ["playwright", "ryzer-cold", "ryzer-warm"],
  ["ryzer-cold", "ryzer-warm", "playwright"],
];
process.stdout.write(
  `Minimal browser-test startup benchmark, ${iterations} measured runs per mode\n`,
);
for (let index = 0; index < iterations; index++) {
  for (const mode of orders[index % orders.length]!) {
    const sample = await execute(mode);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${mode.padEnd(12)} ${(sample.durationMs / 1_000).toFixed(3)}s\n`,
    );
  }
}

const warm = summarize(samples.filter((sample) => sample.mode === "ryzer-warm"));
const cold = summarize(samples.filter((sample) => sample.mode === "ryzer-cold"));
const playwright = summarize(samples.filter((sample) => sample.mode === "playwright"));
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    iterations,
  },
  ryzerWarm: warm,
  ryzerCold: cold,
  playwright,
  warmSpeedup: playwright.medianMs / warm.medianMs,
  coldSpeedup: playwright.medianMs / cold.medianMs,
  warmFallbacks: samples.filter(
    (sample) => sample.mode === "ryzer-warm" && sample.runtime !== "native-pool",
  ).length,
  samples,
};
await writeFile(resolve(outputDir, "overhead.json"), JSON.stringify(report, null, 2));
await writeFile(
  resolve(outputDir, "overhead.md"),
  `# Minimal real-browser test overhead\n\n` +
    `Each process loads one TypeScript test, creates an isolated context and page, mutates the DOM, and asserts text. ` +
    `Warm Ryzer reuses daemon-owned Chromium; cold Ryzer and Playwright launch Chromium per process.\n\n` +
    `| Mode | Median | p95 | vs Playwright |\n|---|---:|---:|---:|\n` +
    `| Ryzer warm | ${(warm.medianMs / 1_000).toFixed(3)}s | ${(warm.p95Ms / 1_000).toFixed(3)}s | ${(playwright.medianMs / warm.medianMs).toFixed(2)}x |\n` +
    `| Ryzer cold | ${(cold.medianMs / 1_000).toFixed(3)}s | ${(cold.p95Ms / 1_000).toFixed(3)}s | ${(playwright.medianMs / cold.medianMs).toFixed(2)}x |\n` +
    `| Playwright | ${(playwright.medianMs / 1_000).toFixed(3)}s | ${(playwright.p95Ms / 1_000).toFixed(3)}s | 1.00x |\n`,
);
process.stdout.write(
  `\nWarm ${report.warmSpeedup.toFixed(2)}x; cold ${report.coldSpeedup.toFixed(2)}x versus Playwright\n`,
);
if (samples.some((sample) => sample.exitCode !== 0) || report.warmFallbacks > 0)
  process.exitCode = 1;

async function execute(mode: Mode): Promise<Sample> {
  const ryzerOutput = resolve(outputDir, `overhead-${mode}`);
  const args =
    mode === "playwright"
      ? [
          resolve(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          resolve(root, "benchmarks/overhead/playwright.config.ts"),
        ]
      : [
          resolve(root, "dist/cli.js"),
          "test",
          resolve(root, "benchmarks/overhead/ryzer.overhead.spec.ts"),
          "--workers",
          "1",
          "--reporter",
          "json",
          "--output",
          ryzerOutput,
        ];
  const env = {
    ...process.env,
    RYZER_DAEMON_IDLE_SECONDS: "600",
    ...(mode === "ryzer-cold" ? { RYZER_DISABLE_DAEMON: "1" } : {}),
  };
  const started = performance.now();
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "ignore" });
    child.on("exit", (code) => done(code ?? 1));
  });
  let runtime: Sample["runtime"];
  if (mode !== "playwright") {
    try {
      const result = JSON.parse(await readFile(resolve(ryzerOutput, "results.json"), "utf8")) as {
        runtime?: Sample["runtime"];
      };
      runtime = result.runtime;
    } catch {
      // The exit code already makes a missing result a failed sample.
    }
  }
  return { mode, durationMs: performance.now() - started, exitCode, runtime };
}

function summarize(samples: Sample[]): { medianMs: number; p95Ms: number; runs: number } {
  const values = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    runs: samples.length,
  };
}

function percentile(values: number[], quantile: number): number {
  return (
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ??
    Number.NaN
  );
}
