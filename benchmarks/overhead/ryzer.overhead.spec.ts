import { expect, test } from "ryzer";

test("minimal real browser test", async ({ page }) => {
  await page.setContent("<output id='ready'>ready</output>");
  await expect(page.locator("#ready")).toHaveText("ready");
});
