import { expect, test } from "../src/index.js";

test.describe("rich locators", () => {
  test("pierces nested open shadow roots for CSS, text, and role", async ({ page }) => {
    await page.setContent(`<div id="outer"></div><output id="result"></output>`);
    await page.evaluate(() => {
      const outer = document.querySelector("#outer")!.attachShadow({ mode: "open" });
      outer.innerHTML = `<section><div id="inner"></div></section>`;
      const inner = outer.querySelector("#inner")!.attachShadow({ mode: "open" });
      inner.innerHTML = `<button class="save">Save profile</button>`;
      inner.querySelector("button")!.addEventListener("click", () => {
        document.querySelector("#result")!.textContent = "saved";
      });
    });
    await page.locator(".save").click();
    await expect(page.getByText("saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible();
  });

  test("tracks late shadow roots without exposing a userland attachShadow wrapper", async ({
    page,
  }) => {
    const signature = await page.evaluate(() => ({
      name: Element.prototype.attachShadow.name,
      length: Element.prototype.attachShadow.length,
      source: Function.prototype.toString.call(Element.prototype.attachShadow),
    }));
    expect(signature.name).toBe("attachShadow");
    expect(signature.length).toBe(1);
    expect(signature.source).toContain("[native code]");

    await page.setContent(`<div id="late"></div>`);
    await page.evaluate(() => {
      const root = document.querySelector("#late")!.attachShadow({ mode: "open" });
      root.innerHTML = `<button>Late root</button>`;
    });
    await expect(page.getByRole("button", { name: "Late root" })).toBeVisible();
  });

  test("locates explicit, wrapping, and aria labels", async ({ page }) => {
    await page.setContent(`
      <label for="email">Email address</label><input id="email">
      <label>Display name <input id="name"></label>
      <input id="search" aria-label="Site search">
    `);
    await page.getByLabel("Email address").fill("a@example.com");
    await page.getByLabel("Display name").fill("Ada");
    await page.getByLabel("Site search", { exact: true }).fill("compiler");
    await expect(page.locator("#email")).toHaveValue("a@example.com");
    await expect(page.locator("#name")).toHaveValue("Ada");
    await expect(page.locator("#search")).toHaveValue("compiler");
  });

  test("supports placeholder, test id, filters, chaining, and indexing", async ({ page }) => {
    await page.setContent(`
      <input placeholder="Filter projects">
      <article data-testid="project"><h2>Alpha</h2><button>Open</button></article>
      <article data-testid="project"><h2>Beta release</h2><button>Open</button></article>
      <article data-testid="project"><h2>Gamma</h2><button>Open</button></article>
      <output id="selected"></output>
      <script>
        document.querySelectorAll('article').forEach(article => article.querySelector('button').onclick = () => {
          document.querySelector('#selected').textContent = article.querySelector('h2').textContent;
        });
      </script>
    `);
    await page.getByPlaceholder("Filter").fill("beta");
    await expect(page.getByTestId("project")).toHaveCount(3);
    const beta = page.getByTestId("project").filter({ hasText: /Beta/ });
    await beta.getByRole("button", { name: "Open" }).click();
    await expect(page.locator("#selected")).toHaveText("Beta release");
    await expect(page.getByTestId("project").first().locator("h2")).toHaveText("Alpha");
    await expect(page.getByTestId("project").nth(1).locator("h2")).toHaveText("Beta release");
    await expect(page.getByTestId("project").last().locator("h2")).toHaveText("Gamma");
  });

  test("supports a custom test-id attribute", async ({ browser }) => {
    const context = await browser.newContext({ testIdAttribute: "data-qa" });
    const page = await context.newPage();
    try {
      await page.setContent(`<button data-qa="publish">Publish</button>`);
      await expect(page.getByTestId("publish")).toHaveText("Publish");
    } finally {
      await context.close();
    }
  });

  test("waits for controls added inside an existing shadow root", async ({ page }) => {
    await page.setContent(`<div id="host"></div>`);
    await page.evaluate(() => {
      const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
      setTimeout(() => {
        shadow.innerHTML = `<button>Eventually ready</button>`;
      }, 80);
    });
    await expect(page.getByRole("button", { name: "Eventually ready" })).toBeVisible();
  });
});
