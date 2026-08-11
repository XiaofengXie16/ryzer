import { isDeepStrictEqual } from "node:util";

import { LOCATOR_BRAND, Locator } from "./locator.js";

interface MatcherOptions {
  timeoutMs?: number;
}

export interface LocatorMatchers {
  toBeVisible(options?: MatcherOptions): Promise<void>;
  toBeHidden(options?: MatcherOptions): Promise<void>;
  toHaveText(expected: string, options?: MatcherOptions): Promise<void>;
  toContainText(expected: string, options?: MatcherOptions): Promise<void>;
  toHaveValue(expected: string, options?: MatcherOptions): Promise<void>;
  toHaveCount(expected: number, options?: MatcherOptions): Promise<void>;
  toHaveAttribute(name: string, expected: string | null, options?: MatcherOptions): Promise<void>;
}

export interface ValueMatchers<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(expected: unknown): void;
  toMatch(expected: string | RegExp): void;
}

export function expect(actual: Locator): LocatorMatchers;
export function expect<T>(actual: T): ValueMatchers<T>;
export function expect<T>(actual: T | Locator): LocatorMatchers | ValueMatchers<T> {
  if (
    actual instanceof Locator ||
    Boolean((actual as unknown as { [LOCATOR_BRAND]?: boolean })?.[LOCATOR_BRAND])
  ) {
    const locator = actual as Locator;
    return {
      toBeVisible: async (options = {}) =>
        await locator._expect({ kind: "visible" }, options.timeoutMs),
      toBeHidden: async (options = {}) =>
        await locator._expect({ kind: "hidden" }, options.timeoutMs),
      toHaveText: async (expected, options = {}) =>
        await locator._expect({ kind: "text", expected }, options.timeoutMs),
      toContainText: async (expected, options = {}) =>
        await locator._expect({ kind: "containText", expected }, options.timeoutMs),
      toHaveValue: async (expected, options = {}) =>
        await locator._expect({ kind: "value", expected }, options.timeoutMs),
      toHaveCount: async (expected, options = {}) =>
        await locator._expect({ kind: "count", expected }, options.timeoutMs),
      toHaveAttribute: async (name, expected, options = {}) =>
        await locator._expect({ kind: "attribute", name, expected }, options.timeoutMs),
    };
  }
  const fail = (matcher: string, expected?: unknown): never => {
    throw new Error(
      `expect(${format(actual)}).${matcher}(${expected === undefined ? "" : format(expected)}) failed`,
    );
  };
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) fail("toBe", expected);
    },
    toEqual(expected) {
      if (!isDeepStrictEqual(actual, expected)) fail("toEqual", expected);
    },
    toBeTruthy() {
      if (!actual) fail("toBeTruthy");
    },
    toBeFalsy() {
      if (actual) fail("toBeFalsy");
    },
    toContain(expected) {
      const includes = (actual as unknown as { includes?: (value: unknown) => boolean })?.includes;
      if (typeof includes !== "function" || !includes.call(actual, expected))
        fail("toContain", expected);
    },
    toMatch(expected) {
      const value = String(actual);
      const pass = expected instanceof RegExp ? expected.test(value) : value.includes(expected);
      if (!pass) fail("toMatch", expected);
    },
  };
}

function format(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
