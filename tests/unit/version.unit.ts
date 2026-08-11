import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { packageVersion } from "../../src/version.js";

test("CLI version is sourced from the package manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(packageVersion(), manifest.version);
});
