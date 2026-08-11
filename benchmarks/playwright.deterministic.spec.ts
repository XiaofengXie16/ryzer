import { expect, test } from "@playwright/test";

import { DETERMINISTIC_CASES, deterministicUrl, TIMER_DELAY_MS } from "./deterministic-shared.js";

const useVirtualClock = process.env.PW_CLOCK === "1";

for (let index = 0; index < DETERMINISTIC_CASES; index++) {
  test(`${useVirtualClock ? "virtual" : "real"}-time transaction ${index}`, async ({ page }) => {
    if (useVirtualClock) await page.clock.install();
    await page.goto(deterministicUrl(index));
    await page.getByRole("button", { name: "Start" }).click();
    if (useVirtualClock) await page.clock.fastForward(TIMER_DELAY_MS + 1);
    await expect(page.locator("output")).toHaveText(`ready-${index}`);
  });
}
