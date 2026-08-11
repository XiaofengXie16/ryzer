import { expect, test } from "../src/index.js";
import { DETERMINISTIC_CASES, deterministicUrl } from "./deterministic-shared.js";

for (let index = 0; index < DETERMINISTIC_CASES; index++) {
  test(`real-time transaction ${index}`, async ({ page }) => {
    await page.goto(deterministicUrl(index));
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.locator("output")).toHaveText(`ready-${index}`);
  });
}
