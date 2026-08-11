import { expect, test } from "../src/index.js";
import { EXPECT_TIMEOUT_MS, STRESS_CASES, stressUrl } from "./stress-shared.js";

for (let index = 0; index < STRESS_CASES; index++) {
  test(`near-deadline update ${index}`, async ({ page }) => {
    await page.goto(stressUrl(index));
    await expect(page.locator("#status")).toHaveText(`ready-${index}`, {
      timeoutMs: EXPECT_TIMEOUT_MS,
    });
  });
}
