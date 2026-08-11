import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserContext } from "../../src/browser.js";
import { Page } from "../../src/page.js";
import type { CdpSession } from "../../src/protocol.js";

test("goto retries Chrome's explicit aborted-navigation signal", async () => {
  const navigations: string[] = [];
  let attempt = 0;
  const session = {
    on: () => () => undefined,
    send: async (method: string, params: { url?: string }) => {
      assert.equal(method, "Page.navigate");
      navigations.push(params.url ?? "");
      attempt++;
      return attempt === 1 ? { errorText: "net::ERR_ABORTED" } : { loaderId: "loader-2" };
    },
  } as unknown as CdpSession;
  const page = new Page({} as BrowserContext, "target", session, {
    baseURL: "https://example.test/base/",
  });

  await page.goto("destination", { waitUntil: "commit" });

  assert.deepEqual(navigations, [
    "https://example.test/base/destination",
    "https://example.test/base/destination",
  ]);
});
