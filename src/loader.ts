import { existsSync } from "node:fs";
import module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { trace } from "./trace.js";

/** Extensions a relative specifier may resolve to once TypeScript sources are
 * mapped back from their emitted `.js` specifier. */
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];

let hookInstalled: boolean | undefined;

/** Node can strip types itself, but its resolver does not map the `./foo.js`
 * specifier a TypeScript project writes back onto `./foo.ts`. A resolve-only
 * hook closes exactly that gap, which keeps esbuild off the critical path for
 * suites whose files import helpers relatively — that is, nearly all of them. */
function installResolveHook(): boolean {
  if (hookInstalled !== undefined) return hookInstalled;
  const registerHooks = (
    module as unknown as {
      registerHooks?: (hooks: {
        resolve(
          specifier: string,
          context: unknown,
          next: (specifier: string, context: unknown) => unknown,
        ): unknown;
      }) => void;
    }
  ).registerHooks;
  if (
    typeof registerHooks !== "function" ||
    (process.features as unknown as { typescript?: string }).typescript !== "strip"
  ) {
    hookInstalled = false;
    return false;
  }
  registerHooks({
    resolve(specifier, context, next) {
      const mapped = mapToSource(specifier, (context as { parentURL?: string }).parentURL);
      return mapped ? next(mapped, context) : next(specifier, context);
    },
  });
  hookInstalled = true;
  return true;
}

/** Returns a rewritten specifier when a TypeScript source backs it, otherwise
 * undefined so the caller defers to Node's own resolution. */
function mapToSource(specifier: string, parentURL?: string): string | undefined {
  if (!parentURL) return undefined;
  // Bare specifiers belong to package resolution; rewriting them would bypass
  // exports maps and reach into dependency sources.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  let path: string;
  try {
    path = fileURLToPath(new URL(specifier, parentURL));
  } catch {
    return undefined;
  }
  const candidates: string[] = [];
  const emitted = /\.([cm]?)js$/.exec(path);
  if (emitted) {
    // `./foo.js` is how a TypeScript project spells `./foo.ts`.
    const stem = path.slice(0, -emitted[0].length);
    const modifier = emitted[1] ?? "";
    candidates.push(`${stem}.${modifier}ts`, `${stem}.ts`, `${stem}.tsx`);
  } else if (!/\.[^/\\.]+$/.test(path)) {
    // Extensionless: `./helper` and directory entry points.
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${path}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${path}/index${extension}`);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return undefined;
}

/** V8 bytecode caching across CLI invocations. Node compiles the runner graph
 * and every stripped test file on each run; the cache removes that repeatedly. */
export function enableCompileCache(): void {
  const enable = (module as unknown as { enableCompileCache?: () => unknown }).enableCompileCache;
  if (typeof enable === "function") {
    try {
      enable();
    } catch {
      // A read-only or full cache directory must never fail a test run.
    }
  }
}

/** Imports a TypeScript (or JavaScript) module, preferring Node's built-in type
 * stripping and falling back to tsx only for syntax Node cannot strip. */
export async function importTypeScript(url: string): Promise<unknown> {
  if (installResolveHook()) {
    try {
      const loaded = await import(url);
      trace("import:strip", url);
      return loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
        throw error;
      // Non-erasable syntax (parameter properties, enum, namespace, import =)
      // is a parse-time failure, so no module in the graph has evaluated yet
      // and re-importing through tsx cannot double-register anything.
      trace("import:strip-unsupported", url);
    }
  }
  const { tsImport } = await import("tsx/esm/api");
  const loaded = await tsImport(url, import.meta.url);
  trace("import:tsx", url);
  return loaded;
}
