import { createServer } from "node:http";

import { expect, test } from "../src/index.js";

function pageUrl(body: string, script = ""): string {
  const html = `<!doctype html><html><head><title>Ryzer fixture</title></head><body>${body}<script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

test.describe("core browser API", () => {
  test("navigates and reads page state", async ({ page }) => {
    await page.goto(pageUrl("<main><h1>Hello Ryzer</h1></main>"));
    expect(await page.title()).toBe("Ryzer fixture");
    await expect(page.getByRole("heading", { name: "Hello Ryzer" })).toBeVisible();
    await expect(page.getByText("Hello Ryzer", { exact: true })).toHaveText("Hello Ryzer");
  });

  test("waits in the browser for asynchronous DOM state", async ({ page }) => {
    await page.goto(
      pageUrl(
        "<div id='root'>loading</div>",
        "setTimeout(() => { document.querySelector('#root').textContent = 'ready'; }, 80)",
      ),
    );
    await expect(page.locator("#root")).toHaveText("ready");
  });

  test("clicks a stable real hit target", async ({ page }) => {
    await page.goto(
      pageUrl(
        "<button id='action' style='position:relative'>Run</button><output id='result'>idle</output>",
        `const button = document.querySelector('#action');
         let moves = 0;
         const timer = setInterval(() => {
           button.style.left = (++moves % 2) + 'px';
           if (moves === 4) clearInterval(timer);
         }, 8);
         button.addEventListener('click', event => {
           document.querySelector('#result').textContent = event.isTrusted ? 'trusted-click' : 'synthetic-click';
         });`,
      ),
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("#result")).toHaveText("trusted-click");
  });

  test("locator assertions cross a navigation realm without a retry", async ({ page }) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      response.setHeader("content-type", "text/html");
      if (url.pathname === "/next") {
        response.flushHeaders();
        setTimeout(
          () => response.end(`<h1>Destination ${url.searchParams.get("iteration")}</h1>`),
          5,
        );
        return;
      }
      response.end(
        `<a id="next" href="/next?iteration=${url.searchParams.get("iteration")}">Next</a>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server did not bind a TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (let iteration = 0; iteration < 25; iteration++) {
        await page.goto(`${origin}/?iteration=${iteration}`, { waitUntil: "domcontentloaded" });
        await page.locator("#next").click();
        await expect(page.locator("h1")).toHaveText(`Destination ${iteration}`);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("fills through the native setter and emits framework-compatible events", async ({
    page,
  }) => {
    await page.goto(
      pageUrl(
        "<label for='email'>Email</label><input id='email'><output id='mirror'></output>",
        "document.querySelector('#email').addEventListener('input', event => document.querySelector('#mirror').textContent = event.target.value)",
      ),
    );
    await page.getByRole("textbox", { name: "Email" }).fill("hello@example.com");
    await expect(page.locator("#email")).toHaveValue("hello@example.com");
    await expect(page.locator("#mirror")).toHaveText("hello@example.com");
  });

  test("supports attributes, counts, visibility, and hidden waits", async ({ page }) => {
    await page.goto(
      pageUrl(
        "<ul><li data-kind='a'>one</li><li data-kind='b'>two</li></ul><div id='toast'>saved</div>",
        "setTimeout(() => document.querySelector('#toast').remove(), 50)",
      ),
    );
    await expect(page.locator("li")).toHaveCount(2);
    await expect(page.locator("li[data-kind='a']")).toHaveAttribute("data-kind", "a");
    await page.locator("#toast").waitFor({ state: "hidden" });
    await expect(page.locator("#toast")).toBeHidden();
  });

  test("evaluates serializable functions", async ({ page }) => {
    await page.goto(pageUrl("<div id='value'>7</div>"));
    const result = await page.evaluate(
      ({ increment }) => Number(document.querySelector("#value")?.textContent) + increment,
      { increment: 5 },
    );
    expect(result).toBe(12);
  });

  test("handles hover, keyboard, checkbox, and select controls", async ({ page }) => {
    await page.goto(
      pageUrl(
        `
      <button id="hover">Hover me</button><output id="hovered">no</output>
      <input id="check" type="checkbox"><label for="check">Enabled</label>
      <label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <label for="command">Command</label><input id="command"><output id="key">none</output>
    `,
        `
      document.querySelector('#hover').addEventListener('mouseenter', () => document.querySelector('#hovered').textContent = 'yes');
      document.querySelector('#command').addEventListener('keydown', event => {
        if (event.key === 'Enter') document.querySelector('#key').textContent = 'enter';
      });
    `,
      ),
    );
    await page.locator("#hover").hover();
    await expect(page.locator("#hovered")).toHaveText("yes");
    await page.locator("#check").check();
    expect(await page.locator("#check").isChecked()).toBe(true);
    await page.locator("#check").uncheck();
    expect(await page.locator("#check").isChecked()).toBe(false);
    expect(await page.locator("#choice").selectOption("b")).toEqual(["b"]);
    await expect(page.locator("#choice")).toHaveValue("b");
    await page.locator("#command").press("Enter");
    await expect(page.locator("#key")).toHaveText("enter");
  });
});

test("intercepts requests and clears routes at the reset boundary", async ({ page }) => {
  const server = createServer((request, response) => {
    response.setHeader(
      "content-type",
      request.url === "/api/data" ? "application/json" : "text/html",
    );
    response.end(
      request.url === "/api/data"
        ? JSON.stringify({ source: "real" })
        : `<button id="load">Load</button><output id="result"></output><script>
          document.querySelector('#load').onclick = async () => {
            const data = await fetch('/api/data').then(response => response.json());
            document.querySelector('#result').textContent = data.source;
          };
        </script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await page.route(
      "**/api/data",
      async (route) => await route.fulfill({ json: { source: "mocked" } }),
    );
    await page.goto(origin);
    await page.locator("#load").click();
    await expect(page.locator("#result")).toHaveText("mocked");
    await page._resetForNextTest();
    await page.goto(origin);
    await page.locator("#load").click();
    await expect(page.locator("#result")).toHaveText("real");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("each test runs in an isolated browser context", async ({ page, browser }) => {
  const storageFixture = new URL("./fixtures/storage.html", import.meta.url).href;
  await page.goto(storageFixture);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.evaluate(() => localStorage.setItem("test", "private"));
  expect(await page.evaluate(() => localStorage.getItem("test"))).toBe("private");
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto(storageFixture);
  expect(await otherPage.evaluate(() => localStorage.getItem("test"))).toBe(null);
  await otherContext.close();
});

test("fast reset isolation clears persistent and realm state", async ({ page }) => {
  const storageFixture = new URL("./fixtures/storage.html", import.meta.url).href;
  await page.goto(storageFixture);
  await page.evaluate(() => {
    localStorage.setItem("leak", "no");
    sessionStorage.setItem("leak", "no");
    window.name = "leak";
    (globalThis as typeof globalThis & { testLeak?: string }).testLeak = "no";
  });
  await page._resetForNextTest();
  expect(await page.evaluate(() => location.href)).toBe("about:blank");
  await page.goto(storageFixture);
  expect(await page.evaluate(() => localStorage.getItem("leak"))).toBe(null);
  expect(await page.evaluate(() => sessionStorage.getItem("leak"))).toBe(null);
  expect(await page.evaluate(() => window.name)).toBe("");
  expect(
    await page.evaluate(() => (globalThis as typeof globalThis & { testLeak?: string }).testLeak),
  ).toBe(undefined);
});
