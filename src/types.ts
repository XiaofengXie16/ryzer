export type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

export interface LaunchOptions {
  executablePath?: string;
  headless?: boolean;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  launchTimeoutMs?: number;
}

export interface PageOptions {
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  baseURL?: string;
  defaultTimeoutMs?: number;
  defaultNavigationTimeoutMs?: number;
  testIdAttribute?: string;
}

export interface GotoOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}

export interface ActionOptions {
  timeoutMs?: number;
}

export interface ClickOptions extends ActionOptions {
  button?: "left" | "middle" | "right";
  clickCount?: number;
}

export interface FillOptions extends ActionOptions {}

export interface WaitForOptions extends ActionOptions {
  state?: "attached" | "detached" | "visible" | "hidden";
}

export interface RequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: string;
}

export interface FulfillOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  json?: unknown;
  contentType?: string;
}

export type RouteHandler = (
  route: import("./route.js").Route,
  request: RequestInfo,
) => void | Promise<void>;

export interface LocatorSpec {
  kind: "css" | "text" | "role" | "label" | "placeholder" | "testId";
  value: string;
  exact?: boolean;
  name?: string | RegExp;
  attribute?: string;
  parent?: LocatorSpec;
  index?: number;
  hasText?: string | RegExp;
}

export interface RunnerConfig extends LaunchOptions, PageOptions {
  testDir?: string;
  workers?: number;
  retries?: number;
  timeoutMs?: number;
  outputDir?: string;
  match?: RegExp;
  reporter?: "line" | "dot" | "json";
  isolation?: "reset" | "context";
  /** Reuse daemon-owned warm browsers between runs. Enabled when supported. */
  nativePool?: boolean;
  /** Reuse passed hermetic results when their complete dependency capsule is unchanged. */
  incremental?: boolean;
  /** Project boundary scanned by the native incremental fingerprint engine. */
  projectRoot?: string;
  /** Capsule storage directory, relative to projectRoot by default. */
  incrementalCacheDir?: string;
  /** Generated directories that cannot affect test behavior and should not be fingerprinted. */
  incrementalExcludes?: string[];
}

export interface TestFixtures {
  page: import("./page.js").Page;
  context: import("./browser.js").BrowserContext;
  browser: import("./browser.js").Browser;
}

export type TestFunction = (fixtures: TestFixtures) => void | Promise<void>;
