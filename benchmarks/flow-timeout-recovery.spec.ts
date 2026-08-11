import { test } from "../src/index.js";

let attempts = 0;

test("cancels a resident flow before retry", async ({ page }) => {
  attempts++;
  await page.setContent("<output>clean</output>");
  if (attempts === 1) {
    await page.flow().expectText("output", "never", { timeoutMs: 5_000 }).run();
  }
  await page.flow().expectText("output", "clean").run();
});

test("the resident VM accepts a new transaction after cancellation", async ({ page }) => {
  await page.setContent("<output>next</output>");
  await page.flow().expectText("output", "next").run();
});
