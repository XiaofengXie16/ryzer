#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { tsImport } from "tsx/esm/api";

import { runTests } from "./runner.js";
import type { RunnerConfig } from "./types.js";
import { packageVersion } from "./version.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "help") return help();
  if (args[0] === "--version" || args[0] === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "test";
  if (command !== "test") throw new Error(`Unknown command: ${command}`);
  const { options, paths } = parseArgs(args);
  const config = { ...(await loadConfig(options.config)), ...options.configOverrides };
  const summary = await runTests(config, paths);
  if (summary.counts.failed > 0) process.exitCode = 1;
}

function parseArgs(args: string[]): {
  options: { config?: string; configOverrides: RunnerConfig };
  paths: string[];
} {
  const paths: string[] = [];
  const configOverrides: RunnerConfig = {};
  let config: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    const next = () => {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--config" || arg === "-c") config = next();
    else if (arg === "--workers" || arg === "-w")
      configOverrides.workers = positiveInteger(next(), arg);
    else if (arg === "--retries") configOverrides.retries = nonNegativeInteger(next(), arg);
    else if (arg === "--timeout") configOverrides.timeoutMs = positiveInteger(next(), arg);
    else if (arg === "--output") configOverrides.outputDir = next();
    else if (arg === "--isolation") {
      const isolation = next();
      if (isolation !== "reset" && isolation !== "context")
        throw new Error(`Unknown isolation mode: ${isolation}`);
      configOverrides.isolation = isolation;
    } else if (arg === "--headed") configOverrides.headless = false;
    else if (arg === "--no-native-pool") configOverrides.nativePool = false;
    else if (arg === "--incremental") configOverrides.incremental = true;
    else if (arg === "--no-incremental") configOverrides.incremental = false;
    else if (arg === "--reporter") {
      const reporter = next();
      if (reporter !== "line" && reporter !== "dot" && reporter !== "json")
        throw new Error(`Unknown reporter: ${reporter}`);
      configOverrides.reporter = reporter;
    } else if (arg === "--help" || arg === "-h") {
      help();
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else paths.push(arg);
  }
  return { options: { config, configOverrides }, paths };
}

async function loadConfig(explicit?: string): Promise<RunnerConfig> {
  const candidates = explicit
    ? [resolve(explicit)]
    : ["ryzer.config.ts", "ryzer.config.mts", "ryzer.config.js", "ryzer.config.mjs"].map((name) =>
        resolve(name),
      );
  const path = candidates.find(existsSync);
  if (!path) return {};
  const module = (await tsImport(pathToFileURL(path).href, import.meta.url)) as {
    default?: RunnerConfig;
  };
  return module.default ?? {};
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${option} must be a non-negative integer`);
  return parsed;
}

function help(): void {
  process.stdout.write(`Ryzer — fast, deterministic browser tests

Usage:
  ryzer test [paths...] [options]

Options:
  -c, --config <path>     Configuration file
  -w, --workers <count>   Parallel workers
      --retries <count>   Retry failed tests in a fresh context
      --timeout <ms>      Per-test timeout
      --output <dir>      Failure artifacts and JSON results
      --isolation <mode>  reset (fast default) or context (fresh target)
      --headed            Show the browser
      --no-native-pool    Disable persistent warm browser workers
      --incremental       Reuse safe native result capsules for unaffected tests
      --no-incremental    Disable configured result-capsule reuse
      --reporter <kind>   line, dot, or json
  -h, --help              Show this help
`);
}

main().catch((error) => {
  process.stderr.write(
    `Ryzer error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
