import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** A realistic suite shape: many test files, each importing shared helpers
 * through relative specifiers. The single-file overhead benchmark cannot show
 * per-file loading cost, and its lone bare import is the one specifier form
 * that never needed a transform in the first place. */
type Mode = "ryzer" | "playwright";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, "benchmarks/suite-fixture");
const iterations = Number(process.env.SUITE_ITERATIONS ?? 5);

const samples: Array<{ mode: Mode; durationMs: number; exitCode: number }> = [];
await execute("ryzer");
await execute("playwright");

process.stdout.write(
  `Realistic suite benchmark (12 files, 24 tests), ${iterations} runs per mode\n`,
);
for (let index = 0; index < iterations; index++) {
  for (const mode of index % 2 === 0
    ? (["ryzer", "playwright"] as const)
    : (["playwright", "ryzer"] as const)) {
    const sample = await execute(mode);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${mode.padEnd(11)} ${(sample.durationMs / 1_000).toFixed(3)}s${sample.exitCode === 0 ? "" : ` (exit ${sample.exitCode})`}\n`,
    );
  }
}

const ryzer = summarize("ryzer");
const playwright = summarize("playwright");
process.stdout.write(
  `\nRyzer median ${(ryzer / 1_000).toFixed(3)}s; Playwright median ${(playwright / 1_000).toFixed(3)}s; ${(playwright / ryzer).toFixed(2)}x\n`,
);
if (samples.some((sample) => sample.exitCode !== 0)) process.exitCode = 1;

function summarize(mode: Mode): number {
  const values = samples
    .filter((sample) => sample.mode === mode)
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

async function execute(mode: Mode): Promise<{ mode: Mode; durationMs: number; exitCode: number }> {
  const args =
    mode === "playwright"
      ? [
          resolve(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          resolve(fixture, "playwright.config.ts"),
        ]
      : [
          resolve(root, "dist/cli.js"),
          "test",
          resolve(fixture, "tests"),
          "--reporter",
          "dot",
          "--output",
          resolve(root, "benchmark-results", "suite-ryzer"),
        ];
  const started = performance.now();
  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: mode === "playwright" ? fixture : root,
      stdio: "ignore",
      env: { ...process.env, RYZER_TRACE: "0" },
    });
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  return { mode, durationMs: performance.now() - started, exitCode };
}
