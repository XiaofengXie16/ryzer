import { expect, test } from "@playwright/test";

import { cases } from "./group-a-data.js";

for (const item of cases) {
  test(item.title, async ({ page }) => {
    await page.setContent(`<label for="query">Query</label><input id="query">
      <button>Commit</button><output>idle</output><script>
      const input = document.querySelector('input');
      const output = document.querySelector('output');
      input.addEventListener('input', () => { output.textContent = 'typing:' + input.value; });
      document.querySelector('button').addEventListener('click', () => { output.textContent = 'done:' + input.value; });
    </script>`);
    await page.getByLabel("Query").fill(item.value);
    await expect(page.locator("output")).toHaveText(`typing:${item.value}`);
    await page.getByRole("button", { name: "Commit" }).click();
    await expect(page.locator("output")).toHaveText(`done:${item.value}`);
  });
}
