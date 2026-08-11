import { expect, test } from "../src/index.js";

test.describe("compiled browser transactions", () => {
  test.flow("records ordinary locator syntax as one transaction", async ({ page }) => {
    await page.setContent(`<label for="query">Query</label><input id="query">
      <button>Search</button><output>idle</output><script>
      const input = document.querySelector('input');
      const output = document.querySelector('output');
      input.addEventListener('input', () => { output.textContent = 'typing:' + input.value; });
      document.querySelector('button').addEventListener('click', () => { output.textContent = 'done:' + input.value; });
    </script>`);
    await page.getByLabel("Query").fill("ordinary-syntax");
    await expect(page.locator("output")).toHaveText("typing:ordinary-syntax");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator("output")).toHaveText("done:ordinary-syntax");
  });

  test.flow("records explicit time advancement with ordinary locator syntax", async ({ page }) => {
    await page.setContent(`<button>Start</button><output>pending</output><script>
      document.querySelector('button').addEventListener('click', () => setTimeout(() => {
        document.querySelector('output').textContent = 'ready';
      }, 1000));
    </script>`);
    await page.getByRole("button", { name: "Start" }).click();
    await page.advanceTime(1_001);
    await expect(page.locator("output")).toHaveText("ready");
  });

  test("batches renderer work around trusted input boundaries", async ({ page }) => {
    await page.setContent(`<label for="query">Query</label><input id="query">
      <button>Search</button><output>idle</output><script>
      const input = document.querySelector('input');
      const output = document.querySelector('output');
      input.addEventListener('input', () => output.textContent = 'typing:' + input.value);
      document.querySelector('button').addEventListener('click', () => setTimeout(() => {
        output.textContent = 'done:' + input.value;
      }, 25));
    </script>`);

    await page
      .flow()
      .fill(page.getByLabel("Query"), "transaction")
      .expectText("output", "typing:transaction")
      .click(page.getByRole("button", { name: "Search" }))
      .expectText("output", "done:transaction")
      .run();
  });

  test("supports hover, double click, keyboard, and assertions in one IR", async ({ page }) => {
    await page.setContent(`<button>Act</button><input><output>0</output><script>
      const button = document.querySelector('button');
      const output = document.querySelector('output');
      button.addEventListener('mouseenter', () => button.dataset.hovered = 'yes');
      button.addEventListener('dblclick', () => output.textContent = '2');
    </script>`);

    await page
      .flow()
      .hover("button")
      .expectAttribute("button", "data-hovered", "yes")
      .dblclick("button")
      .expectText("output", "2")
      .press("input", "a")
      .expectValue("input", "a")
      .run();
  });

  test("completes a transaction whose final instruction is trusted input", async ({ page }) => {
    await page.setContent(`<button>Finish</button><output>idle</output><script>
      document.querySelector('button').addEventListener('click', () => {
        document.querySelector('output').textContent = 'clicked';
      });
    </script>`);
    await page.flow().click("button").run();
    await expect(page.locator("output")).toHaveText("clicked");
  });

  test("compiles portable IR without touching the page", async ({ page }) => {
    const flow = page
      .flow()
      .fill(page.getByRole("textbox", { name: /query/i }), "compiled")
      .expectCount(page.getByTestId("row"), 3);
    const ir = flow.compile();
    expect(ir.length).toBe(2);
    expect(ir[0]?.operation).toBe("fill");
    expect(ir[1]?.args).toEqual({ kind: "count", expected: 3 });
    expect(JSON.parse(JSON.stringify(ir))[0].spec.nameRegex).toEqual({
      source: "query",
      flags: "i",
    });
  });

  test("advances application timers deterministically without wall-clock waiting", async ({
    page,
  }) => {
    await page.setContent(`<button>Act</button><output>pending</output><script>
      document.querySelector('button').onclick = () => setTimeout(() => {
        document.querySelector('output').textContent = 'ready';
      }, 1000);
    </script>`);
    await page.evaluate(() => {
      window.name = "virtual-time-dirty";
    });
    const started = performance.now();
    await page.flow().click("button").advanceTime(1_001).expectText("output", "ready").run();
    expect(performance.now() - started < 500).toBeTruthy();
  });

  test("discards a failed resident transaction before the next flow", async ({ page }) => {
    await page.setContent("<output>actual</output>");
    let message = "";
    try {
      await page.flow().expectText("output", "never", { timeoutMs: 40 }).run();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("expected text");
    await page.flow().expectText("output", "actual").run();
  });

  test("rejects unsafe page boundaries and value reads while recording", async ({ page }) => {
    await page.setContent(`<input value="before"><output>actual</output>`);
    let boundaryError = "";
    try {
      await page.transaction(async () => {
        await page.locator("input").fill("deferred");
        await page.evaluate(() => document.title);
      });
    } catch (error) {
      boundaryError = error instanceof Error ? error.message : String(error);
    }
    expect(boundaryError).toContain("cannot run after deferred locator steps");
    await expect(page.locator("input")).toHaveValue("before");

    let readError = "";
    try {
      await page.transaction(async () => {
        await page.locator("output").textContent();
      });
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    expect(readError).toContain("cannot be safely deferred");
  });

  test("retires virtual-time targets before a later next-frame movement", async ({ page }) => {
    expect(await page.evaluate(() => window.name)).toBe("");
    await page.setContent(`<style>body{margin:0}</style><button>Move</button><output></output><script>
      const button = document.querySelector('button');
      const output = document.querySelector('output');
      let clicks = 0;
      button.addEventListener('click', () => {
        clicks++;
        output.textContent += Math.round(button.getBoundingClientRect().left) + ',';
        if (clicks === 1) requestAnimationFrame(() => { button.style.transform = 'translateX(120px)'; });
      });
    </script>`);

    await page
      .flow()
      .click("button")
      .expectText("output", "0,")
      .click("button")
      .expectText("output", "0,120,")
      .run();
  });
});
