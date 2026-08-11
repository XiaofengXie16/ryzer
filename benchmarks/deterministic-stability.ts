import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DETERMINISTIC_CASES } from "./deterministic-shared.js";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results/deterministic-stability-latest");
const iterations = Number(process.env.DETERMINISTIC_STABILITY_ITERATIONS ?? 20);
await mkdir(outputDir, { recursive: true });
const samples: Array<{ iteration: number; failed: number; durationMs: number; exitCode: number }> =
  [];

process.stdout.write(
  `Flow virtual-time stability: ${DETERMINISTIC_CASES} tests x ${iterations} runs\n`,
);
for (let iteration = 1; iteration <= iterations; iteration++) {
  const started = performance.now();
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "dist/cli.js"),
        "test",
        resolve(root, "benchmarks/ryzer.deterministic.flow.spec.ts"),
        "--workers",
        "4",
        "--reporter",
        "json",
        "--output",
        outputDir,
      ],
      { cwd: root, env: process.env, stdio: "ignore" },
    );
    child.on("exit", (code) => done(code ?? 1));
  });
  let failed = DETERMINISTIC_CASES;
  try {
    const result = JSON.parse(await readFile(resolve(outputDir, "results.json"), "utf8")) as {
      counts: { failed: number };
    };
    failed = result.counts.failed;
  } catch {
    // A missing result counts as a fully failed run.
  }
  samples.push({ iteration, failed, exitCode, durationMs: performance.now() - started });
  process.stdout.write(`${iteration}/${iterations} ${failed}/${DETERMINISTIC_CASES} failed\n`);
}

const total = DETERMINISTIC_CASES * iterations;
const failed = samples.reduce((sum, sample) => sum + sample.failed, 0);
const report = {
  generatedAt: new Date().toISOString(),
  iterations,
  casesPerRun: DETERMINISTIC_CASES,
  total,
  failed,
  observedFailureRate: failed / total,
  samples,
};
await writeFile(
  resolve(root, "benchmark-results/deterministic-stability.json"),
  JSON.stringify(report, null, 2),
);
await writeFile(
  resolve(root, "benchmark-results/deterministic-stability.md"),
  `# Flow virtual-time stability\n\n${total} timer-driven compiled transactions, no retries. ` +
    `Observed failures: **${failed}/${total}** (${(report.observedFailureRate * 100).toFixed(2)}%).\n`,
);
process.stdout.write(`\nFlow virtual-time failures: ${failed}/${total}\n`);
if (failed > 0 || samples.some((sample) => sample.exitCode !== 0)) process.exitCode = 1;
