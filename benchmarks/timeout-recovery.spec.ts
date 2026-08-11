import { expect, test } from "../src/index.js";

let attempts = 0;

test("cancels renderer work before retrying a timed-out test", async ({ page }) => {
  attempts++;
  if (attempts === 1) {
    await expect(page.locator("#never-exists")).toBeVisible({ timeoutMs: 5_000 });
  }
  await page.setContent("<output id='state'>retry-clean</output>");
  await expect(page.locator("#state")).toHaveText("retry-clean");
});

test("the worker remains clean after timeout cancellation", async ({ page }) => {
  await page.setContent("<output id='state'>next-clean</output>");
  await expect(page.locator("#state")).toHaveText("next-clean");
});
