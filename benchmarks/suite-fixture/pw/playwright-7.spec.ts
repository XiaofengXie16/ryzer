import { expect, test } from "@playwright/test";

import { scenariosFor } from "./support.js";

for (const item of scenariosFor(7, 2)) {
  test(`playwright ${item.heading}`, async ({ page }) => {
    await page.setContent(item.body);
    await expect(page.locator("#target")).toHaveText(item.heading);
  });
}
