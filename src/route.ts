import type { CdpSession } from "./protocol.js";
import type { FulfillOptions, RequestInfo } from "./types.js";

export class Route {
  #handled = false;

  constructor(
    private readonly session: CdpSession,
    private readonly requestId: string,
    readonly request: RequestInfo,
  ) {}

  get handled(): boolean {
    return this.#handled;
  }

  async continue(
    overrides: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    } = {},
  ): Promise<void> {
    this.#claim();
    await this.session.send("Fetch.continueRequest", {
      requestId: this.requestId,
      ...overrides,
      ...(overrides.headers
        ? { headers: Object.entries(overrides.headers).map(([name, value]) => ({ name, value })) }
        : {}),
      ...(overrides.postData
        ? { postData: Buffer.from(overrides.postData).toString("base64") }
        : {}),
    });
  }

  async fulfill(options: FulfillOptions = {}): Promise<void> {
    this.#claim();
    let body: Buffer;
    const headers = { ...options.headers };
    if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      headers["content-type"] ??= options.contentType ?? "application/json; charset=utf-8";
    } else {
      body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? "");
      if (options.contentType) headers["content-type"] ??= options.contentType;
    }
    headers["content-length"] ??= String(body.byteLength);
    await this.session.send("Fetch.fulfillRequest", {
      requestId: this.requestId,
      responseCode: options.status ?? 200,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: body.toString("base64"),
    });
  }

  async abort(reason = "Failed"): Promise<void> {
    this.#claim();
    await this.session.send("Fetch.failRequest", {
      requestId: this.requestId,
      errorReason: reason,
    });
  }

  #claim(): void {
    if (this.#handled) throw new Error("Route was already handled");
    this.#handled = true;
  }
}
