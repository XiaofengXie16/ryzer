import { expect, test } from "../src/index.js";

test("Chrome virtual time advances timers without poisoning later input", async ({ page }) => {
  await page.goto(
    `data:text/html,${encodeURIComponent(`<button>Act</button><output>pending</output><script>
    setTimeout(() => document.querySelector('output').textContent = 'ready', 1000);
    document.querySelector('button').onclick = () => document.querySelector('button').dataset.clicked = 'yes';
  </script>`)}`,
  );
  const started = performance.now();
  const expired = page.session.once("Emulation.virtualTimeBudgetExpired");
  await page.session.send("Emulation.setVirtualTimePolicy", {
    policy: "advance",
    budget: 1_000,
    maxVirtualTimeTaskStarvationCount: 10_000,
  });
  await expired;
  await page.session.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
  expect(performance.now() - started < 500).toBeTruthy();
  await expect(page.locator("output")).toHaveText("ready");
  await page.getByRole("button", { name: "Act" }).click();
  await expect(page.locator("button")).toHaveAttribute("data-clicked", "yes");
});
