import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  chromium,
  expect as playwrightExpect,
  type Page as PlaywrightPage,
} from "@playwright/test";

import { Browser } from "../src/browser.js";
import type { Page } from "../src/page.js";

const NODES = Number(process.env.LARGE_DOM_NODES ?? 50_000);
const STEPS = Number(process.env.LARGE_DOM_STEPS ?? 6);
const ITERATIONS = Number(process.env.LARGE_DOM_ITERATIONS ?? 5);
const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "benchmark-results");
await mkdir(outputDir, { recursive: true });

const noise = Array.from(
  { length: NODES },
  (_, index) => `<div class="noise"><span>row-${index}</span></div>`,
).join("");
const html = `<!doctype html><html><body>${noise}
  <label for="query">Query</label><input id="query">
  <button>Search</button><output id="result">idle</output>
  <script>
    const input = document.querySelector('#query');
    const result = document.querySelector('#result');
    input.addEventListener('input', () => { result.textContent = 'typing:' + input.value; });
    document.querySelector('button').addEventListener('click', () => { result.textContent = 'done:' + input.value; });
  </script>
</body></html>`;

const ryzerBrowser = await Browser.launch();
const ryzerContext = await ryzerBrowser.newContext();
const ryzerPage = await ryzerContext.newPage();
await ryzerPage.setContent(html);
const playwrightBrowser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const playwrightPage = await playwrightBrowser.newPage();
await playwrightPage.setContent(html);

type Lane = "ryzer" | "playwright";
const samples: Array<{ lane: Lane; durationMs: number }> = [];
await runRyzer(ryzerPage, -1);
await runPlaywright(playwrightPage, -1);
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  const order: Lane[] = iteration % 2 ? ["playwright", "ryzer"] : ["ryzer", "playwright"];
  for (const lane of order) {
    const started = performance.now();
    if (lane === "ryzer") await runRyzer(ryzerPage, iteration);
    else await runPlaywright(playwrightPage, iteration);
    const durationMs = performance.now() - started;
    samples.push({ lane, durationMs });
    process.stdout.write(
      `${iteration + 1}/${ITERATIONS} ${lane.padEnd(10)} ${(durationMs / 1_000).toFixed(3)}s\n`,
    );
  }
}

await ryzerContext.close();
await ryzerBrowser.close();
await playwrightBrowser.close();
const ryzer = summarize("ryzer");
const playwright = summarize("playwright");
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    nodes: NODES,
    steps: STEPS,
  },
  ryzer,
  playwright,
  speedup: playwright.medianMs / ryzer.medianMs,
  samples,
};
await writeFile(resolve(outputDir, "large-dom.json"), JSON.stringify(report, null, 2));
await writeFile(
  resolve(outputDir, "large-dom.md"),
  `# Large-DOM transaction benchmark\n\n` +
    `${NODES.toLocaleString()} inert nodes plus one six-step interactive form, with browser setup excluded.\n\n` +
    `| Runner | Median | p95 |\n|---|---:|---:|\n` +
    `| Ryzer Flow | ${(ryzer.medianMs / 1_000).toFixed(3)}s | ${(ryzer.p95Ms / 1_000).toFixed(3)}s |\n` +
    `| Playwright | ${(playwright.medianMs / 1_000).toFixed(3)}s | ${(playwright.p95Ms / 1_000).toFixed(3)}s |\n\n` +
    `Ryzer speedup: **${report.speedup.toFixed(2)}x**.\n`,
);
process.stdout.write(`\nLarge-DOM speedup: ${report.speedup.toFixed(2)}x\n`);

async function resetPage(page: Page | PlaywrightPage): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector("input") as HTMLInputElement).value = "";
    document.querySelector("output")!.textContent = "idle";
  });
}

async function runRyzer(page: Page, iteration: number): Promise<void> {
  await resetPage(page);
  const flow = page.flow();
  for (let step = 0; step < STEPS; step++) {
    const term = `term-${iteration}-${step}`;
    flow
      .fill(page.getByLabel("Query"), term)
      .expectText("#result", `typing:${term}`)
      .click(page.getByRole("button", { name: "Search" }))
      .expectText("#result", `done:${term}`);
  }
  await flow.run();
}

async function runPlaywright(page: PlaywrightPage, iteration: number): Promise<void> {
  await resetPage(page);
  for (let step = 0; step < STEPS; step++) {
    const term = `term-${iteration}-${step}`;
    await page.getByLabel("Query").fill(term);
    await playwrightExpect(page.locator("#result")).toHaveText(`typing:${term}`);
    await page.getByRole("button", { name: "Search" }).click();
    await playwrightExpect(page.locator("#result")).toHaveText(`done:${term}`);
  }
}

function summarize(lane: Lane): { medianMs: number; p95Ms: number; runs: number } {
  const values = samples
    .filter((sample) => sample.lane === lane)
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b);
  return {
    medianMs: values[Math.ceil(values.length * 0.5) - 1] ?? Number.NaN,
    p95Ms: values[Math.ceil(values.length * 0.95) - 1] ?? Number.NaN,
    runs: values.length,
  };
}
