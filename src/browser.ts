import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Page } from "./page.js";
import { CdpConnection, CdpSession } from "./protocol.js";
import type { LaunchOptions, PageOptions } from "./types.js";

const EXECUTABLE_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value): value is string => Boolean(value));

export async function resolveChromeExecutable(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { access } = await import("node:fs/promises");
  for (const candidate of EXECUTABLE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional browser location.
    }
  }
  throw new Error(
    "Chrome or Chromium was not found. Set CHROME_PATH or launch({ executablePath }).",
  );
}

function waitForWebSocket(
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let diagnostic = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Chrome did not expose DevTools within ${timeoutMs}ms${diagnostic ? `\n${diagnostic}` : ""}`,
        ),
      );
    }, timeoutMs);
    const lines = createInterface({ input: process.stderr });
    const onLine = (line: string) => {
      diagnostic = `${diagnostic}\n${line}`.slice(-4_000);
      const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match?.[1]) return;
      cleanup();
      resolve(match[1]);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Chrome exited before DevTools was ready (exit ${code})${diagnostic}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      lines.off("line", onLine);
      process.off("exit", onExit);
      lines.close();
    };
    lines.on("line", onLine);
    process.once("exit", onExit);
  });
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

export class Browser {
  #closed = false;
  #contexts = new Set<BrowserContext>();
  #sessionsByTarget = new Map<string, string>();
  #sessionWaiters = new Map<string, (sessionId: string) => void>();
  #warmAdoptTried = false;

  private constructor(
    readonly connection: CdpConnection,
    readonly process?: ChildProcessWithoutNullStreams,
    readonly profilePath?: string,
  ) {
    connection.on<{ sessionId: string; targetInfo: { targetId: string } }>(
      "Target.attachedToTarget",
      ({ sessionId, targetInfo }) => {
        const resolve = this.#sessionWaiters.get(targetInfo.targetId);
        if (resolve) {
          this.#sessionWaiters.delete(targetInfo.targetId);
          resolve(sessionId);
        } else {
          this.#sessionsByTarget.set(targetInfo.targetId, sessionId);
        }
      },
    );
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executable = await resolveChromeExecutable(options.executablePath);
    const profilePath = await mkdtemp(join(tmpdir(), "ryzer-chrome-"));
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-extensions",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--metrics-recording-only",
      "--disable-sync",
      "--no-service-autorun",
      "--no-startup-window",
      "--password-store=basic",
      "--use-mock-keychain",
      options.headless === false ? "" : "--headless=new",
      ...(options.args ?? []),
    ].filter(Boolean);
    const child = spawn(executable, args, {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const wsUrl = await waitForWebSocket(child, options.launchTimeoutMs ?? 15_000);
      const connection = await CdpConnection.connect(wsUrl, options.launchTimeoutMs ?? 15_000);
      const browser = new Browser(connection, child, profilePath);
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      return browser;
    } catch (error) {
      child.kill("SIGKILL");
      await rm(profilePath, { recursive: true, force: true });
      throw error;
    }
  }

  /** Connect to a browser owned by ryzerd. Closing this object only releases
   * its contexts and CDP transport; the daemon keeps the process warm. */
  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<Browser> {
    const connection = await CdpConnection.connect(wsUrl, timeoutMs);
    const browser = new Browser(connection);
    try {
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      return browser;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async newContext(options: PageOptions = {}): Promise<BrowserContext> {
    if (this.#closed) throw new Error("Browser is closed");
    const { browserContextId } = await this.connection.send<{ browserContextId: string }>(
      "Target.createBrowserContext",
      { disposeOnDetach: true },
    );
    const context = new BrowserContext(this, browserContextId, options);
    this.#contexts.add(context);
    return context;
  }

  async newPage(options: PageOptions = {}): Promise<Page> {
    const context = await this.newContext(options);
    return await context.newPage();
  }

  /** Creates a context and page and forces Chrome to fork the renderer for it.
   * Called by the detached warmer after a run exits, never on a critical path:
   * within one browser this fork blocks whatever else that browser is doing. */
  async _parkWarmContext(): Promise<void> {
    const { browserContextId } = await this.connection.send<{ browserContextId: string }>(
      "Target.createBrowserContext",
      { disposeOnDetach: false },
    );
    const { targetId } = await this.connection.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const sessionId = await this._sessionForTarget(targetId);
    await new CdpSession(this.connection, sessionId).send("Page.getFrameTree", {});
  }

  /** Whether a context is already parked here, so the warmer can stay additive
   * and still bound itself to one parked context per browser. */
  async _hasParkedContext(): Promise<boolean> {
    const { targetInfos } = await this.connection.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
      {},
    );
    return targetInfos.some(
      (target) => target.type === "page" && target.url === "about:blank" && target.browserContextId,
    );
  }

  /** Adopts a context parked by the warmer after the previous run. Creating a
   * context, its target, and waiting for Chrome to fork the renderer costs
   * roughly 250ms; adopting one costs single-digit milliseconds. */
  async _adoptWarmContext(
    options: PageOptions,
  ): Promise<{ context: BrowserContext; page: Page } | undefined> {
    // Only one context is ever parked, so a second lookup spends a round trip
    // to learn nothing.
    if (this.#closed || this.#warmAdoptTried) return undefined;
    this.#warmAdoptTried = true;
    let targetInfos: TargetInfo[];
    try {
      ({ targetInfos } = await this.connection.send<{ targetInfos: TargetInfo[] }>(
        "Target.getTargets",
        {},
      ));
    } catch {
      return undefined;
    }
    const pages = targetInfos.filter(
      (target): target is TargetInfo & { browserContextId: string } =>
        target.type === "page" && Boolean(target.browserContextId),
    );
    // A parked context is always left at about:blank. Anything else in this
    // exclusively leased browser is debris from a run that died before cleanup.
    const warm = pages.find((target) => target.url === "about:blank");
    for (const id of new Set(pages.map((target) => target.browserContextId))) {
      if (id === warm?.browserContextId) continue;
      void this.connection
        .send("Target.disposeBrowserContext", { browserContextId: id })
        .catch(() => undefined);
    }
    if (!warm) return undefined;
    const context = new BrowserContext(this, warm.browserContextId, options);
    this.#contexts.add(context);
    try {
      return { context, page: await context._adoptPage(warm.targetId) };
    } catch {
      await context.close().catch(() => undefined);
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#contexts].map((context) => context.close()));
    if (!this.process || !this.profilePath) {
      this.connection.close();
      return;
    }
    const child = this.process;
    const profilePath = this.profilePath;
    // All contexts are already disposed and the profile is throwaway. Asking
    // Chrome to gracefully close first adds another protocol round-trip and
    // starts slow profile finalization that we immediately discard.
    this.connection.close();
    if (child.exitCode === null) {
      // This process owns a throwaway profile and every context is already
      // disposed. A graceful Chrome shutdown routinely burns ~1 second, so
      // terminate the isolated worker immediately after Browser.close acks.
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    await rm(profilePath, { recursive: true, force: true });
  }

  _forget(context: BrowserContext): void {
    this.#contexts.delete(context);
  }

  async _sessionForTarget(targetId: string): Promise<string> {
    const existing = this.#sessionsByTarget.get(targetId);
    if (existing) {
      this.#sessionsByTarget.delete(targetId);
      return existing;
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#sessionWaiters.delete(targetId);
        reject(new Error(`Chrome did not auto-attach to target ${targetId}`));
      }, 5_000);
      this.#sessionWaiters.set(targetId, (sessionId) => {
        clearTimeout(timer);
        resolve(sessionId);
      });
    });
  }
}

export class BrowserContext {
  #closed = false;
  #pages = new Set<Page>();

  constructor(
    readonly browser: Browser,
    readonly id: string,
    readonly options: PageOptions,
  ) {}

  async newPage(): Promise<Page> {
    if (this.#closed) throw new Error("Browser context is closed");
    const { targetId } = await this.browser.connection.send<{ targetId: string }>(
      "Target.createTarget",
      {
        url: "about:blank",
        browserContextId: this.id,
      },
    );
    const sessionId = await this.browser._sessionForTarget(targetId);
    const page = new Page(
      this,
      targetId,
      new CdpSession(this.browser.connection, sessionId),
      this.options,
    );
    await page._initialize();
    this.#pages.add(page);
    return page;
  }

  /** Attaches to a target that existed before this connection, so auto-attach
   * never announced it. */
  async _adoptPage(targetId: string): Promise<Page> {
    const { sessionId } = await this.browser.connection.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const page = new Page(
      this,
      targetId,
      new CdpSession(this.browser.connection, sessionId),
      this.options,
    );
    await page._initialize();
    this.#pages.add(page);
    return page;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pages = [...this.#pages];
    try {
      await this.browser.connection.send("Target.disposeBrowserContext", {
        browserContextId: this.id,
      });
    } catch {
      // A browser shutdown may already have disposed the context.
    }
    for (const page of pages) page._didClose();
    this.browser._forget(this);
  }

  _forget(page: Page): void {
    this.#pages.delete(page);
  }
}

export async function launch(options: LaunchOptions = {}): Promise<Browser> {
  return await Browser.launch(options);
}
