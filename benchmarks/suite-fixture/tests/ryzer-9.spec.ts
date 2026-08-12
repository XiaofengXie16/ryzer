import { expect, test } from "ryzer";

import { scenariosFor } from "./support.js";

for (const item of scenariosFor(9, 2)) {
  test(`ryzer ${item.heading}`, async ({ page }) => {
    await page.setContent(item.body);
    await expect(page.locator("#target")).toHaveText(item.heading);
  });
}
