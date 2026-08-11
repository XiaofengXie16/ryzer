export { Browser, BrowserContext, launch } from "./browser.js";
export { expect } from "./expect.js";
export { Flow } from "./flow.js";
export type { CompiledFlowStep, CompiledLocatorSpec, FlowOperation, FlowStep } from "./flow.js";
export { Locator } from "./locator.js";
export { Page } from "./page.js";
export { Route } from "./route.js";
export { runTests } from "./runner.js";
export { test } from "./test.js";
export type {
  ActionOptions,
  ClickOptions,
  FillOptions,
  GotoOptions,
  LaunchOptions,
  PageOptions,
  RunnerConfig,
  RequestInfo,
  RouteHandler,
  FulfillOptions,
  TestFixtures,
  WaitForOptions,
  WaitUntil,
} from "./types.js";

export function defineConfig<T extends import("./types.js").RunnerConfig>(config: T): T {
  return config;
}
