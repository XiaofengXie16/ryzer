import { readFileSync } from "node:fs";

export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("Ryzer package version is missing");
  return manifest.version;
}
