import type { BrowserContext } from "./browser.js";
import type { CapsuleObservation } from "./capsule.js";
import { Flow, type FlowStep } from "./flow.js";
import { INJECTED_RUNTIME } from "./injected.js";
import { Locator } from "./locator.js";
import type { CdpSession } from "./protocol.js";
import { Route } from "./route.js";
import type { GotoOptions, LocatorSpec, PageOptions, RequestInfo, RouteHandler } from "./types.js";

interface RuntimeResult<T> {
  result: { type: string; value?: T; description?: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
    stackTrace?: {
      callFrames?: Array<{
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      }>;
    };
  };
}

interface RyzerResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

interface FlowRuntimeResult extends RyzerResult<never> {
  flowId: number;
  cursor: number;
  input?:
    | {
        kind: "click";
        x: number;
        y: number;
        button: "left" | "middle" | "right";
        clickCount?: number;
      }
    | { kind: "dblclick"; x: number; y: number; button: "left" | "middle" | "right" }
    | { kind: "hover"; x: number; y: number }
    | { kind: "press"; key: string }
    | { kind: "advanceTime"; milliseconds: number };
}

export class Page {
  readonly defaultTimeoutMs: number;
  readonly defaultNavigationTimeoutMs: number;
  readonly baseURL?: string;
  #closed = false;
  #inflight = new Set<string>();
  #networkChangedAt = performance.now();
  #networkEnabled = false;
  #visitedOrigins = new Set<string>();
  #resetPending = false;
  #routes: Array<{ pattern: string | RegExp; handler: RouteHandler }> = [];
  #fetchEnabled = false;
  #virtualTimeUsed = false;
  #transactionSteps: FlowStep[] | undefined;
  #capsuleUrls = new Set<string>();
  #capsuleReasons = new Set<string>();
  #disposers: Array<() => void> = [];

  constructor(
    readonly context: BrowserContext,
    readonly targetId: string,
    readonly session: CdpSession,
    options: PageOptions,
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.defaultNavigationTimeoutMs = options.defaultNavigationTimeoutMs ?? 15_000;
    this.baseURL = options.baseURL;
  }

  async _initialize(): Promise<void> {
    this.#disposers.push(
      this.session.on<{ requestId: string; type: string; request: { url: string } }>(
        "Network.requestWillBeSent",
        ({ requestId, type, request }) => {
          this.#capsuleUrls.add(request.url);
          if (type === "WebSocket" || type === "EventSource") {
            this.#capsuleReasons.add(`${type} activity is external state`);
          }
          if (type === "WebSocket" || type === "EventSource") return;
          this.#inflight.add(requestId);
          this.#networkChangedAt = performance.now();
        },
      ),
      this.session.on<{ requestId: string }>("Network.loadingFinished", ({ requestId }) => {
        this.#inflight.delete(requestId);
        this.#networkChangedAt = performance.now();
      }),
      this.session.on<{ requestId: string }>("Network.loadingFailed", ({ requestId }) => {
        this.#inflight.delete(requestId);
        this.#networkChangedAt = performance.now();
      }),
      this.session.on<{ frame: { url: string } }>("Page.frameNavigated", ({ frame }) => {
        this.#capsuleUrls.add(frame.url);
        try {
          const origin = new URL(frame.url).origin;
          if (origin !== "null") this.#visitedOrigins.add(origin);
        } catch {
          // about:, data:, and malformed transient URLs have no persistent origin.
        }
      }),
      this.session.on<{
        requestId: string;
        request: {
          url: string;
          method: string;
          headers: Record<string, string>;
          postData?: string;
        };
        resourceType: string;
      }>("Fetch.requestPaused", (event) => {
        void this.#handlePausedRequest(event);
      }),
    );
    const viewport = this.context.options.viewport ?? {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    };
    await Promise.all([
      this.session.send("Page.enable"),
      this.session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      this.session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile: false,
      }),
      this.session.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECTED_RUNTIME }),
      this.#evaluateExpression(INJECTED_RUNTIME),
    ]);
  }

  locator(selector: string): Locator {
    return new Locator(this, { kind: "css", value: selector });
  }

  flow(): Flow {
    if (this.#transactionSteps)
      throw new Error("page.flow() cannot be nested inside page.transaction()");
    return new Flow(this);
  }

  async transaction(
    fn: () => void | Promise<void>,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.#transactionSteps)
      throw new Error("Nested page.transaction() calls are not supported");
    const steps: FlowStep[] = [];
    this.#transactionSteps = steps;
    try {
      await fn();
    } finally {
      this.#transactionSteps = undefined;
    }
    await this._runFlow(steps, options.timeoutMs ?? this.defaultTimeoutMs);
  }

  async advanceTime(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("advanceTime(milliseconds) requires a non-negative finite number");
    }
    if (this._recordTransactionStep({ operation: "advanceTime", args: { milliseconds } })) return;
    await this.#ensureResetRealm();
    await this.#advanceVirtualTime(milliseconds);
  }

  _recordTransactionStep(step: FlowStep): boolean {
    if (!this.#transactionSteps) return false;
    this.#transactionSteps.push(step);
    return true;
  }

  getByText(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "text", value: text, exact: options.exact });
  }

  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return new Locator(this, {
      kind: "role",
      value: role,
      name: options.name,
      exact: options.exact,
    });
  }

  getByLabel(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "label", value: text, exact: options.exact });
  }

  getByPlaceholder(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "placeholder", value: text, exact: options.exact });
  }

  getByTestId(testId: string): Locator {
    return new Locator(this, {
      kind: "testId",
      value: testId,
      attribute: this.context.options.testIdAttribute ?? "data-testid",
    });
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    this.#assertTransactionBoundary("goto");
    this.#assertOpen();
    // The requested navigation itself creates the fresh realm promised by
    // reset isolation, avoiding a redundant about:blank navigation.
    this.#resetPending = false;
    const resolved = this.baseURL ? new URL(url, this.baseURL).href : url;
    const waitUntil = options.waitUntil ?? "load";
    const timeoutMs = options.timeoutMs ?? this.defaultNavigationTimeoutMs;
    if (waitUntil === "networkidle") await this.#enableNetwork();
    const desiredLifecycle = waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "load";
    const seen = new Set<string>();
    let expectedLoader: string | undefined;
    let lifecycleResolve: (() => void) | undefined;
    const lifecycle = new Promise<void>((resolve) => {
      lifecycleResolve = resolve;
    });
    const disposeLifecycle = this.session.on<{ loaderId: string; name: string }>(
      "Page.lifecycleEvent",
      (event) => {
        if (event.name !== desiredLifecycle) return;
        seen.add(event.loaderId);
        if (expectedLoader === event.loaderId) lifecycleResolve?.();
      },
    );
    const result = await this.session.send<{ errorText?: string; loaderId?: string }>(
      "Page.navigate",
      { url: resolved },
    );
    if (result.errorText) throw new Error(`Navigation to ${resolved} failed: ${result.errorText}`);
    expectedLoader = result.loaderId;
    if (expectedLoader && seen.has(expectedLoader)) lifecycleResolve?.();
    if (waitUntil !== "commit" && expectedLoader) {
      try {
        await withTimeout(
          lifecycle,
          timeoutMs,
          `Navigation to ${resolved} timed out waiting for ${waitUntil}`,
        );
      } finally {
        disposeLifecycle();
      }
    } else {
      disposeLifecycle();
    }
    if (waitUntil === "networkidle") await this.waitForNetworkIdle({ timeoutMs });
  }

  async waitForNetworkIdle(options: { idleMs?: number; timeoutMs?: number } = {}): Promise<void> {
    await this.#ensureResetRealm();
    await this.#enableNetwork();
    const idleMs = options.idleMs ?? 400;
    const timeoutMs = options.timeoutMs ?? this.defaultNavigationTimeoutMs;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.#inflight.size === 0 && performance.now() - this.#networkChangedAt >= idleMs) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, idleMs)));
    }
    throw new Error(
      `Network did not become idle within ${timeoutMs}ms (${this.#inflight.size} requests still active)`,
    );
  }

  async evaluate<T, A = undefined>(fn: ((arg: A) => T | Promise<T>) | string, arg?: A): Promise<T> {
    await this.#ensureResetRealm();
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${serialize(arg)})`;
    return await this.#evaluateExpression<T>(expression);
  }

  async title(): Promise<string> {
    return await this.evaluate(() => document.title);
  }

  async url(): Promise<string> {
    return await this.evaluate(() => location.href);
  }

  async content(): Promise<string> {
    return await this.evaluate(() => document.documentElement.outerHTML);
  }

  async setContent(html: string): Promise<void> {
    await this.evaluate((markup) => {
      document.open();
      document.write(markup);
      document.close();
    }, html);
  }

  async waitForURL(expected: string | RegExp, options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.defaultNavigationTimeoutMs;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const actual = await this.url();
      if (
        expected instanceof RegExp
          ? expected.test(actual)
          : actual === (this.baseURL ? new URL(expected, this.baseURL).href : expected)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`URL did not match ${String(expected)} within ${timeoutMs}ms`);
  }

  async route(pattern: string | RegExp, handler: RouteHandler): Promise<void> {
    this.#assertTransactionBoundary("route");
    this.#capsuleReasons.add("request routing can depend on closure state");
    this.#routes.unshift({ pattern, handler });
    if (!this.#fetchEnabled) {
      this.#fetchEnabled = true;
      await this.session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
    }
  }

  async unrouteAll(): Promise<void> {
    this.#assertTransactionBoundary("unrouteAll");
    this.#routes.length = 0;
    if (this.#fetchEnabled) {
      this.#fetchEnabled = false;
      await this.session.send("Fetch.disable").catch(() => undefined);
    }
  }

  async screenshot(options: { path?: string; fullPage?: boolean } = {}): Promise<Buffer> {
    await this.#ensureResetRealm();
    if (options.fullPage) {
      const metrics = await this.session.send<{ contentSize: { width: number; height: number } }>(
        "Page.getLayoutMetrics",
      );
      const result = await this.session.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: metrics.contentSize.width,
          height: metrics.contentSize.height,
          scale: 1,
        },
      });
      const buffer = Buffer.from(result.data, "base64");
      if (options.path) await writeBuffer(options.path, buffer);
      return buffer;
    }
    const result = await this.session.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const buffer = Buffer.from(result.data, "base64");
    if (options.path) await writeBuffer(options.path, buffer);
    return buffer;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.context.browser.connection.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      // Context or browser teardown may win this race.
    }
    this._didClose();
  }

  _didClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const dispose of this.#disposers) dispose();
    this.#disposers.length = 0;
    this.context._forget(this);
  }

  async _resetForNextTest(): Promise<boolean> {
    this.#assertOpen();
    // CDP virtual time is target-scoped and cannot be reliably restored to the
    // wall clock. Reusing that target can make later rAF-based actionability
    // checks consume their synthetic deadline immediately.
    const retireTarget = this.#virtualTimeUsed;
    // Clear document-scoped state before destroying the current realm. CDP's
    // storage clear below handles every origin observed in frames.
    await this.evaluate(async () => {
      try {
        localStorage.clear();
      } catch {}
      try {
        sessionStorage.clear();
      } catch {}
      try {
        window.name = "";
      } catch {}
      try {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
      } catch {}
      try {
        const databases = await indexedDB.databases();
        await Promise.all(
          databases.map(
            (database) =>
              database.name &&
              new Promise<void>((resolve) => {
                const request = indexedDB.deleteDatabase(database.name!);
                request.onsuccess = request.onerror = request.onblocked = () => resolve();
              }),
          ),
        );
      } catch {}
    });
    await this.unrouteAll();
    const origins = [...this.#visitedOrigins];
    // Clear browser-scoped state while the target is known to be fully active;
    // doing it after navigation makes Chrome serialize these commands behind
    // the new document's load event.
    await Promise.all([
      ...origins.map((origin) =>
        this.session
          .send("Storage.clearDataForOrigin", { origin, storageTypes: "all" })
          .catch(() => undefined),
      ),
      this.session.send("Network.clearBrowserCookies").catch(() => undefined),
      this.session.send("Network.clearBrowserCache").catch(() => undefined),
      this.session.send("Page.resetNavigationHistory").catch(() => undefined),
      this.context.browser.connection
        .send("Browser.resetPermissions", { browserContextId: this.context.id })
        .catch(() => undefined),
    ]);
    this.#visitedOrigins.clear();
    this.#inflight.clear();
    this.#networkChangedAt = performance.now();
    if (retireTarget) return false;
    this.#resetPending = true;
    return true;
  }

  _needsTargetRetirement(): boolean {
    return this.#virtualTimeUsed;
  }

  async _beginCapsuleObservation(): Promise<void> {
    this.#capsuleUrls.clear();
    this.#capsuleReasons.clear();
    try {
      await this.#enableNetwork();
      // Test activity begins only after the Network domain is ready.
      this.#capsuleUrls.clear();
    } catch {
      this.#capsuleReasons.add("network observation could not be enabled");
    }
  }

  async _finishCapsuleObservation(): Promise<CapsuleObservation> {
    const resources = new Set(this.#capsuleUrls);
    try {
      const observed = await this.#evaluateExpression<string[]>(
        `[location.href,...performance.getEntriesByType("resource").map(entry=>entry.name)]`,
      );
      for (const resource of observed) resources.add(resource);
    } catch {
      this.#capsuleReasons.add("page resource state was unavailable");
    }
    for (const resource of resources) {
      try {
        const protocol = new URL(resource).protocol;
        if (!["about:", "blob:", "data:", "file:"].includes(protocol)) {
          this.#capsuleReasons.add(`external resource protocol ${protocol}`);
        }
      } catch {
        this.#capsuleReasons.add("unparseable resource URL");
      }
    }
    return {
      hermetic: this.#capsuleReasons.size === 0,
      resources: [...resources],
      reasons: [...this.#capsuleReasons],
    };
  }

  async _runLocator<T>(
    spec: LocatorSpec,
    operation: string,
    args: Record<string, unknown> = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.#transactionSteps) {
      throw new Error(
        `Locator operation ${operation} cannot be safely deferred inside page.transaction()`,
      );
    }
    await this.#ensureResetRealm();
    const normalized = serializeLocatorSpec(spec);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
      // _initialize installs the runtime in the current realm and
      // addScriptToEvaluateOnNewDocument installs it before future page code.
      // Keep the hot command tiny instead of retransmitting ~20 KB per action.
      const expression = `globalThis.__ryzer.run(${serialize(normalized)},${serialize(operation)},${serialize(args)},${remainingMs})`;
      try {
        const result = await this.#evaluateExpression<RyzerResult<T>>(expression);
        if (!result.ok) throw new Error(result.error ?? `Locator operation ${operation} failed`);
        return result.value as T;
      } catch (error) {
        // A trusted click can replace Chrome's execution realm before the next
        // assertion reaches it. That is a synchronization boundary, not a test
        // failure: retry the locator in the new document using the original
        // timeout budget. Non-navigation errors remain fail-fast.
        if (!isNavigationRealmRace(error) || performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  async _runFlow(steps: readonly FlowStep[], timeoutMs = this.defaultTimeoutMs): Promise<void> {
    await this.#ensureResetRealm();
    if (steps.length === 0) return;
    const serialized = steps.map((step) => ({
      ...step,
      ...(step.spec ? { spec: serializeLocatorSpec(step.spec) } : {}),
      timeoutMs: step.timeoutMs ?? timeoutMs,
    }));
    let cursor = 0;
    let flowId: number | undefined;
    let completed = false;
    try {
      for (;;) {
        const result = await this.#evaluateExpression<FlowRuntimeResult>(
          flowId === undefined
            ? `globalThis.__ryzer.beginFlow(${serialize(serialized)})`
            : `globalThis.__ryzer.resumeFlow(${flowId})`,
        );
        flowId = result.flowId;
        if (!result.ok) throw new Error(result.error ?? `Flow failed at step ${result.cursor}`);
        const input = result.input;
        if (!input && result.cursor >= serialized.length) {
          cursor = result.cursor;
          completed = true;
          break;
        }
        if (result.cursor <= cursor && !result.input)
          throw new Error(`Flow stalled at step ${cursor}`);
        cursor = result.cursor;
        if (!input) continue;
        if (input.kind === "advanceTime") {
          await this.#advanceVirtualTime(input.milliseconds);
          continue;
        }
        if (input.kind === "click") {
          await this._click(input.x, input.y, input.button, input.clickCount ?? 1);
        } else if (input.kind === "dblclick") {
          await this._click(input.x, input.y, input.button, 1);
          await this._click(input.x, input.y, input.button, 2);
        } else if (input.kind === "hover") {
          await this._hover(input.x, input.y);
        } else {
          await this._press(input.key);
        }
      }
    } finally {
      if (!completed && flowId !== undefined && !this.session.connection.closed) {
        await this.session
          .send("Runtime.evaluate", {
            expression: `globalThis.__ryzer?.cancelFlow(${flowId})`,
            awaitPromise: false,
            returnByValue: true,
          })
          .catch(() => undefined);
      }
    }
  }

  async _cancelPending(reason: string): Promise<void> {
    if (this.#closed || this.session.connection.closed) return;
    const message = serialize(reason);
    await Promise.allSettled([
      this.session.send("Runtime.evaluate", {
        expression: `globalThis.__ryzer?.cancelAll(${message})`,
        awaitPromise: false,
        returnByValue: true,
      }),
      this.session.send("Page.stopLoading"),
    ]);
  }

  async _click(
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    clickCount: number,
  ): Promise<void> {
    // CDP processes messages from one socket in order, so pipelining these
    // commands preserves input order while paying one round-trip instead of three.
    await Promise.all([
      this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }),
      this.session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount,
      }),
      this.session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount,
      }),
    ]);
  }

  async _hover(x: number, y: number): Promise<void> {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
  }

  async _press(key: string): Promise<void> {
    const definition = keyDefinition(key);
    await Promise.all([
      this.session.send("Input.dispatchKeyEvent", { type: "keyDown", ...definition }),
      this.session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        ...definition,
        text: undefined,
      }),
    ]);
  }

  async #evaluateExpression<T = unknown>(expression: string): Promise<T> {
    this.#assertOpen();
    const response = await this.session.send<RuntimeResult<T>>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: false,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result.value as T;
  }

  async #advanceVirtualTime(milliseconds: number): Promise<void> {
    this.#virtualTimeUsed = true;
    const expired = this.session.once("Emulation.virtualTimeBudgetExpired");
    await this.session.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget: milliseconds,
      maxVirtualTimeTaskStarvationCount: 10_000,
    });
    await withTimeout(expired, 5_000, `Virtual time did not advance ${milliseconds}ms`);
    // Continue synthetic time after the bounded jump so later animation-frame
    // actionability checks are not left paused.
    await this.session.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Page is closed");
  }

  #assertTransactionBoundary(method: string): void {
    if (this.#transactionSteps?.length) {
      throw new Error(
        `page.${method}() cannot run after deferred locator steps inside page.transaction()`,
      );
    }
  }

  async #enableNetwork(): Promise<void> {
    if (this.#networkEnabled) return;
    this.#networkEnabled = true;
    try {
      await this.session.send("Network.enable", { maxTotalBufferSize: 0 });
    } catch (error) {
      this.#networkEnabled = false;
      throw error;
    }
  }

  async #ensureResetRealm(): Promise<void> {
    this.#assertTransactionBoundary("operation");
    if (!this.#resetPending) return;
    this.#resetPending = false;
    try {
      await this.goto("about:blank");
    } catch (error) {
      this.#resetPending = true;
      throw error;
    }
  }

  async #handlePausedRequest(event: {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string>; postData?: string };
    resourceType: string;
  }): Promise<void> {
    const request: RequestInfo = { ...event.request, resourceType: event.resourceType };
    const rule = this.#routes.find(({ pattern }) => matchesURL(pattern, request.url));
    const route = new Route(this.session, event.requestId, request);
    try {
      if (rule) await rule.handler(route, request);
      if (!route.handled) await route.continue();
    } catch {
      if (!route.handled) await route.abort().catch(() => undefined);
    }
  }
}

function serialize(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Value cannot be serialized into the browser");
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function serializeLocatorSpec(spec: LocatorSpec): Record<string, unknown> {
  return {
    ...spec,
    ...(spec.parent ? { parent: serializeLocatorSpec(spec.parent) } : {}),
    ...(spec.name instanceof RegExp
      ? { name: undefined, nameRegex: { source: spec.name.source, flags: spec.name.flags } }
      : {}),
    ...(spec.hasText instanceof RegExp
      ? {
          hasText: undefined,
          hasTextRegex: { source: spec.hasText.source, flags: spec.hasText.flags },
        }
      : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeBuffer(path: string, buffer: Buffer): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function isNavigationRealmRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id)/i.test(
    error.message,
  );
}

function matchesURL(pattern: string | RegExp, url: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(url);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function keyDefinition(key: string): Record<string, unknown> {
  const special: Record<string, { code: string; keyCode: number }> = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Space: { code: "Space", keyCode: 32 },
  };
  const item = special[key];
  if (item)
    return {
      key: key === "Space" ? " " : key,
      code: item.code,
      windowsVirtualKeyCode: item.keyCode,
      nativeVirtualKeyCode: item.keyCode,
    };
  if (key.length === 1)
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      text: key,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  throw new Error(`Unsupported key: ${key}`);
}
