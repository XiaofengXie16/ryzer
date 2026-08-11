/**
 * Compatibility cases adapted from microsoft/playwright's Apache-2.0 test
 * suite. They are intentionally rewritten for Ryzer's public API.
 */
import { expect, test } from "../src/index.js";

test.describe("Playwright reference semantics", () => {
  test("real click survives target removal during pointerdown", async ({ page }) => {
    await page.setContent(`<button id="target">Click</button>`);
    await page.evaluate(() => {
      document.querySelector("#target")?.addEventListener("pointerdown", (event) => {
        (event.currentTarget as Element).remove();
      });
    });
    await page.locator("#target").click();
    await expect(page.locator("#target")).toBeHidden();
  });

  test("DOM mutations do not masquerade as a stable paint frame", async ({ page }) => {
    await page.setContent(`<style>body{margin:0}</style><button>Move</button><output></output><script>
      const button = document.querySelector('button');
      const nativeRect = button.getBoundingClientRect.bind(button);
      let reads = 0;
      button.getBoundingClientRect = () => {
        const rect = nativeRect();
        if (++reads === 1) {
          queueMicrotask(() => { document.body.dataset.unrelated = 'mutation'; });
          requestAnimationFrame(() => { button.style.transform = 'translateX(120px)'; });
        }
        return rect;
      };
      button.addEventListener('pointerdown', () => {
        document.querySelector('output').textContent = Math.round(nativeRect().left);
      });
    </script>`);
    await page.getByRole("button", { name: "Move" }).click();
    await expect(page.locator("output")).toHaveText("120");
  });

  test("double click dispatches click and dblclick", async ({ page }) => {
    await page.setContent(`<button id="target">Click</button><output id="events"></output>`);
    await page.evaluate(() => {
      const events: string[] = [];
      const button = document.querySelector("#target");
      button?.addEventListener("click", () => events.push("click"));
      button?.addEventListener("dblclick", () => events.push("dblclick"));
      button?.addEventListener("dblclick", () => {
        document.querySelector("#events")!.textContent = events.join(",");
      });
    });
    await page.locator("#target").dblclick();
    await expect(page.locator("#events")).toHaveText("click,click,dblclick");
  });

  test("opacity-zero and offscreen elements remain semantically visible", async ({ page }) => {
    await page.setContent(
      `<div id="transparent" style="opacity:0">transparent</div><div id="offscreen" style="position:absolute;left:-1000px">offscreen</div>`,
    );
    await expect(page.locator("#transparent")).toBeVisible();
    await expect(page.locator("#offscreen")).toBeVisible();
  });

  test("fills textarea, text input, and contenteditable", async ({ page }) => {
    await page.setContent(`<textarea></textarea><input><div contenteditable="true"></div>`);
    await page.locator("textarea").fill("textarea value");
    await page.locator("input").fill("input value");
    await page.locator("[contenteditable]").fill("editable value");
    await expect(page.locator("textarea")).toHaveValue("textarea value");
    await expect(page.locator("input")).toHaveValue("input value");
    await expect(page.locator("[contenteditable]")).toHaveText("editable value");
  });

  test("rejects unsupported fill controls", async ({ page }) => {
    for (const type of ["button", "checkbox", "file", "image", "radio", "reset", "submit"]) {
      await page.setContent(`<input type="${type}">`);
      let error: unknown;
      try {
        await page.locator("input").fill("");
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof Error).toBe(true);
      expect((error as Error).message).toContain(`Input of type ${type} cannot be filled`);
    }
  });

  test("accepts valid native date/time/range values and rejects malformed ones", async ({
    page,
  }) => {
    const valid: Record<string, string> = {
      color: "#aaaaaa",
      date: "2020-03-02",
      time: "13:15",
      "datetime-local": "2020-03-02T13:15:30",
      month: "2020-03",
      range: "42",
      week: "2020-W50",
    };
    for (const [type, value] of Object.entries(valid)) {
      await page.setContent(`<input type="${type}" min="0" max="100">`);
      await page.locator("input").fill(value);
      await expect(page.locator("input")).toHaveValue(value);
    }
    await page.setContent(`<input type="date">`);
    let error: unknown;
    try {
      await page.locator("input").fill("2020-13-05");
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain("Malformed value");
  });

  test("fill emits composed input and non-composed change events", async ({ page }) => {
    await page.setContent(`<input><output id="events"></output>`);
    await page.evaluate(() => {
      const events: string[] = [];
      const input = document.querySelector("input")!;
      for (const type of ["input", "change"])
        input.addEventListener(type, (event) => events.push(`${event.type}:${event.composed}`));
      input.addEventListener("change", () => {
        document.querySelector("#events")!.textContent = events.join(",");
      });
    });
    await page.locator("input").fill("value");
    await expect(page.locator("#events")).toHaveText("input:true,change:false");
  });

  test("check and uncheck are idempotent", async ({ page }) => {
    await page.setContent(`<input id="box" type="checkbox">`);
    await page.locator("#box").check();
    await page.locator("#box").check();
    expect(await page.locator("#box").isChecked()).toBe(true);
    await page.locator("#box").uncheck();
    await page.locator("#box").uncheck();
    expect(await page.locator("#box").isChecked()).toBe(false);
  });
});
