import { expect, test } from "../src/index.js";

let attempts = 0;

test("replaces a crashed browser and retries on a fresh process", async ({ browser, page }) => {
  attempts++;
  if (attempts === 1) {
    await browser.connection.send("Browser.crash").catch(() => undefined);
    throw new Error("intentional browser crash");
  }
  await page.setContent("<output id='state'>recovered</output>");
  await expect(page.locator("#state")).toHaveText("recovered");
});

test("the recovered worker remains healthy", async ({ page }) => {
  await page.setContent("<button>healthy</button>");
  await expect(page.getByRole("button", { name: "healthy" })).toBeVisible();
});
