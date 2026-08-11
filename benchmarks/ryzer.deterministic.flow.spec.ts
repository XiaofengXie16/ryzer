import { test } from "../src/index.js";
import { DETERMINISTIC_CASES, deterministicUrl, TIMER_DELAY_MS } from "./deterministic-shared.js";

for (let index = 0; index < DETERMINISTIC_CASES; index++) {
  test(`virtual-time transaction ${index}`, async ({ page }) => {
    await page.goto(deterministicUrl(index));
    await page
      .flow()
      .click(page.getByRole("button", { name: "Start" }))
      .advanceTime(TIMER_DELAY_MS + 1)
      .expectText("output", `ready-${index}`)
      .run();
  });
}
