import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { STRESS_CASES } from "./stress-shared.js";

type Framework = "ryzer" | "playwright";
interface Sample {
  framework: Framework;
  failed: number;
  exitCode: number;
  durationMs: number;
}

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
const iterations = Number(process.env.STABILITY_ITERATIONS ?? 10);
await mkdir(outputDir, { recursive: true });
const samples: Sample[] = [];
process.stdout.write(
  `Stability stress: ${STRESS_CASES} near-deadline tests × ${iterations} runs per framework\n`,
);

for (let index = 0; index < iterations; index++) {
  const order: Framework[] = index % 2 === 0 ? ["ryzer", "playwright"] : ["playwright", "ryzer"];
  for (const framework of order) {
    const sample = await execute(framework);
    samples.push(sample);
    process.stdout.write(
      `${index + 1}/${iterations} ${framework.padEnd(10)} ${sample.failed}/${STRESS_CASES} false failures, ${(sample.durationMs / 1_000).toFixed(2)}s\n`,
    );
  }
}

const ryzerFailed = totalFailed("ryzer");
const playwrightFailed = totalFailed("playwright");
const total = STRESS_CASES * iterations;
const ryzerRate = ryzerFailed / total;
const playwrightRate = playwrightFailed / total;
const relativeRate =
  playwrightRate === 0
    ? ryzerRate === 0
      ? 1
      : Number.POSITIVE_INFINITY
    : ryzerRate / playwrightRate;
const passed = playwrightFailed > 0 && relativeRate <= 0.5;
const report = {
  generatedAt: new Date().toISOString(),
  casesPerRun: STRESS_CASES,
  iterations,
  totalCasesPerFramework: total,
  ryzer: { failed: ryzerFailed, flakeRate: ryzerRate },
  playwright: { failed: playwrightFailed, flakeRate: playwrightRate },
  relativeFlakeRate: relativeRate,
  passed,
  samples,
};
await writeFile(resolve(outputDir, "stability.json"), JSON.stringify(report, null, 2));
await writeFile(
  resolve(outputDir, "stability.md"),
  `# Stability stress benchmark\n\n` +
    `${total} identical near-deadline DOM-update cases per framework, no retries.\n\n` +
    `| Runner | False failures | Rate |\n|---|---:|---:|\n` +
    `| Ryzer | ${ryzerFailed} | ${(ryzerRate * 100).toFixed(2)}% |\n` +
    `| Playwright | ${playwrightFailed} | ${(playwrightRate * 100).toFixed(2)}% |\n\n` +
    `Relative Ryzer flake rate: ${Number.isFinite(relativeRate) ? `${(relativeRate * 100).toFixed(1)}%` : "infinite"}. Target: ${passed ? "PASS" : "FAIL"}.\n`,
);
process.stdout.write(
  `\nRyzer ${ryzerFailed}/${total}; Playwright ${playwrightFailed}/${total}; target ${passed ? "PASS" : "FAIL"}\n`,
);
if (!passed) process.exitCode = 2;

function totalFailed(framework: Framework): number {
  return samples
    .filter((sample) => sample.framework === framework)
    .reduce((sum, sample) => sum + sample.failed, 0);
}

async function execute(framework: Framework): Promise<Sample> {
  const ryzerOutput = resolve(outputDir, "stability-ryzer-latest");
  const args =
    framework === "ryzer"
      ? [
          resolve(root, "dist/cli.js"),
          "test",
          resolve(root, "benchmarks/ryzer.stress.spec.ts"),
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
          resolve(root, "benchmarks/playwright.stability.config.ts"),
        ];
  const started = performance.now();
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "ignore" });
    child.on("exit", (code) => done(code ?? 1));
  });
  let failed = STRESS_CASES;
  try {
    if (framework === "ryzer") {
      const parsed = JSON.parse(await readFile(resolve(ryzerOutput, "results.json"), "utf8")) as {
        counts: { failed: number };
      };
      failed = parsed.counts.failed;
    } else {
      const parsed = JSON.parse(
        await readFile(
          resolve(root, "benchmarks/benchmark-results/stability-playwright.json"),
          "utf8",
        ),
      ) as { stats: { unexpected: number } };
      failed = parsed.stats.unexpected;
    }
  } catch {
    // A missing/corrupt result is itself a failed run.
  }
  return { framework, failed, exitCode, durationMs: performance.now() - started };
}
