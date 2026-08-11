import { EventEmitter } from "node:events";

import WebSocket from "ws";

export interface ProtocolEvent<T = Record<string, unknown>> {
  method: string;
  params: T;
  sessionId?: string;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface ProtocolMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
  sessionId?: string;
}

export interface TimelineEntry {
  at: number;
  direction: "send" | "receive" | "event";
  method: string;
  sessionId?: string;
  durationMs?: number;
  error?: string;
}

export class CdpConnection {
  readonly events = new EventEmitter();
  readonly timeline: TimelineEntry[] = [];
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#onMessage(data.toString()));
    socket.on("close", () => this.#onClose(new Error("Browser connection closed")));
    socket.on("error", (error) => this.#onClose(error));
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting to browser after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed) throw new Error("Cannot send a command: browser connection is closed");
    const id = this.#nextId++;
    const started = performance.now();
    this.#record({ at: Date.now(), direction: "send", method, sessionId });
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    try {
      const value = await result;
      this.#record({
        at: Date.now(),
        direction: "receive",
        method,
        sessionId,
        durationMs: performance.now() - started,
      });
      return value;
    } catch (error) {
      this.#record({
        at: Date.now(),
        direction: "receive",
        method,
        sessionId,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  on<T = Record<string, unknown>>(
    method: string,
    listener: (params: T, sessionId?: string) => void,
    sessionId?: string,
  ): () => void {
    const key = sessionId ? `${sessionId}:${method}` : method;
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }

  once<T = Record<string, unknown>>(method: string, sessionId?: string): Promise<T> {
    const key = sessionId ? `${sessionId}:${method}` : method;
    return new Promise((resolve) => this.events.once(key, resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#onClose(new Error("Browser connection closed"));
  }

  #onMessage(raw: string): void {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(raw) as ProtocolMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const detail = message.error.data ? `: ${message.error.data}` : "";
        pending.reject(new Error(`${pending.method}: ${message.error.message}${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    this.#record({
      at: Date.now(),
      direction: "event",
      method: message.method,
      sessionId: message.sessionId,
    });
    const params = message.params ?? {};
    this.events.emit(message.method, params, message.sessionId);
    if (message.sessionId) this.events.emit(`${message.sessionId}:${message.method}`, params);
  }

  #onClose(error: Error): void {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.events.emit("disconnected", error);
  }

  #record(entry: TimelineEntry): void {
    this.timeline.push(entry);
    if (this.timeline.length > 5_000) this.timeline.shift();
  }
}

export class CdpSession {
  constructor(
    readonly connection: CdpConnection,
    readonly id: string,
  ) {}

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.connection.send<T>(method, params, this.id);
  }

  on<T = Record<string, unknown>>(method: string, listener: (params: T) => void): () => void {
    return this.connection.on<T>(method, listener, this.id);
  }

  once<T = Record<string, unknown>>(method: string): Promise<T> {
    return this.connection.once<T>(method, this.id);
  }
}
