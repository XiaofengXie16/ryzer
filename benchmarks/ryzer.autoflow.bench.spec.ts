import { expect, test } from "../src/index.js";
import { benchmarkUrl, CASES, STEPS } from "./shared.js";

for (let index = 0; index < CASES; index++) {
  test.flow(`ordinary-syntax transaction ${index}`, async ({ page }) => {
    await page.goto(benchmarkUrl(index));
    for (let step = 0; step < STEPS; step++) {
      const term = `term-${index}-${step}`;
      await page.getByRole("textbox", { name: "Query" }).fill(term);
      await expect(page.locator("#result")).toHaveText(`typing:${term}`);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.locator("#result")).toHaveText(`done:${term}`);
    }
    await expect(page.locator("li")).toHaveCount(3);
  });
}
