import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeDependencies } from "../../src/capsule.js";
import { fingerprintProject } from "../../src/native.js";

test("native SHA-256 fingerprint detects same-size edits and respects excludes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryzer-fingerprint-"));
  try {
    await mkdir(join(root, ".ryzer"));
    await writeFile(join(root, "source.ts"), "one");
    await writeFile(join(root, "tab\tname.ts"), "tab");
    await writeFile(join(root, ".ryzer", "cache.json"), "ignored");
    const before = await fingerprintProject(root, [".ryzer"]);
    await writeFile(join(root, "source.ts"), "two");
    const after = await fingerprintProject(root, [".ryzer"]);
    assert.notEqual(before.files["source.ts"], after.files["source.ts"]);
    assert.ok(after.files["tab\tname.ts"]);
    assert.equal(after.files[".ryzer/cache.json"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency analysis follows local imports and rejects dynamic inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryzer-dependencies-"));
  try {
    await writeFile(join(root, "helper.ts"), "export const value = 'safe';\n");
    await writeFile(
      join(root, "safe.spec.ts"),
      "import { value } from './helper.js'; export const title = 'ordinary tests require no rewrite'; export const result = value;\n",
    );
    await writeFile(join(root, "unsafe.spec.ts"), "export const value = process.env.VALUE;\n");
    await writeFile(
      join(root, "browser-unsafe.spec.ts"),
      "export const markup = '<script>fetch(\\\"/api\\\")<\\/script>';\n",
    );
    await writeFile(
      join(root, "template-unsafe.spec.ts"),
      "export const value = `value:${process.env.VALUE}`;\n",
    );
    const safe = await analyzeDependencies(join(root, "safe.spec.ts"), root);
    assert.equal(safe.safe, true);
    assert.deepEqual([...safe.dependencies].sort(), ["helper.ts", "safe.spec.ts"]);
    assert.equal((await analyzeDependencies(join(root, "unsafe.spec.ts"), root)).safe, false);
    assert.equal(
      (await analyzeDependencies(join(root, "browser-unsafe.spec.ts"), root)).safe,
      false,
    );
    assert.equal(
      (await analyzeDependencies(join(root, "template-unsafe.spec.ts"), root)).safe,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency analysis rejects a source symlink escaping the project", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ryzer-symlink-"));
  const root = join(parent, "project");
  try {
    await mkdir(root);
    await writeFile(join(parent, "outside.ts"), "export const value = 'outside';\n");
    await symlink(join(parent, "outside.ts"), join(root, "linked.ts"));
    assert.equal((await analyzeDependencies(join(root, "linked.ts"), root)).safe, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
