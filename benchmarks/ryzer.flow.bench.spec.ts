import { test } from "../src/index.js";
import { benchmarkUrl, CASES, STEPS } from "./shared.js";

for (let index = 0; index < CASES; index++) {
  test(`compiled transaction ${index}`, async ({ page }) => {
    await page.goto(benchmarkUrl(index));
    const flow = page.flow();
    for (let step = 0; step < STEPS; step++) {
      const term = `term-${index}-${step}`;
      flow
        .fill(page.getByRole("textbox", { name: "Query" }), term)
        .expectText("#result", `typing:${term}`)
        .click(page.getByRole("button", { name: "Search" }))
        .expectText("#result", `done:${term}`);
    }
    await flow.expectCount("li", 3).run();
  });
}
