import { Locator } from "./locator.js";
import type { Page } from "./page.js";
import type { ClickOptions, LocatorSpec, WaitForOptions } from "./types.js";

export type FlowOperation =
  | "fill"
  | "click"
  | "dblclick"
  | "hover"
  | "press"
  | "select"
  | "state"
  | "expect"
  | "advanceTime";

export interface FlowStep {
  operation: FlowOperation;
  spec?: LocatorSpec;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CompiledLocatorSpec extends Omit<LocatorSpec, "name" | "parent" | "hasText"> {
  name?: string;
  nameRegex?: { source: string; flags: string };
  parent?: CompiledLocatorSpec;
  hasText?: string;
  hasTextRegex?: { source: string; flags: string };
}

export interface CompiledFlowStep extends Omit<FlowStep, "spec"> {
  spec?: CompiledLocatorSpec;
}

/**
 * A declarative transaction compiled into a compact renderer-side program.
 * Fluent methods only build IR; run() crosses the browser boundary.
 */
export class Flow {
  #steps: FlowStep[] = [];

  constructor(readonly page: Page) {}

  fill(target: Locator | string, value: string, options: { timeoutMs?: number } = {}): this {
    return this.#push(target, "fill", { value }, options.timeoutMs);
  }

  click(target: Locator | string, options: ClickOptions = {}): this {
    return this.#push(
      target,
      "click",
      {
        button: options.button ?? "left",
        clickCount: options.clickCount ?? 1,
      },
      options.timeoutMs,
    );
  }

  dblclick(target: Locator | string, options: Omit<ClickOptions, "clickCount"> = {}): this {
    return this.#push(target, "dblclick", { button: options.button ?? "left" }, options.timeoutMs);
  }

  hover(target: Locator | string, options: { timeoutMs?: number } = {}): this {
    return this.#push(target, "hover", {}, options.timeoutMs);
  }

  press(target: Locator | string, key: string, options: { timeoutMs?: number } = {}): this {
    return this.#push(target, "press", { key }, options.timeoutMs);
  }

  selectOption(
    target: Locator | string,
    value: string | string[],
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#push(target, "select", { values: value }, options.timeoutMs);
  }

  /** Advance Chromium's synthetic clock without waiting in wall-clock time. */
  advanceTime(milliseconds: number): this {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new Error("Virtual time must be a positive number of milliseconds");
    }
    this.#steps.push({ operation: "advanceTime", args: { milliseconds } });
    return this;
  }

  waitFor(target: Locator | string, options: WaitForOptions = {}): this {
    return this.#push(target, "state", { state: options.state ?? "visible" }, options.timeoutMs);
  }

  expectVisible(target: Locator | string, options: { timeoutMs?: number } = {}): this {
    return this.#expect(target, { kind: "visible" }, options.timeoutMs);
  }

  expectHidden(target: Locator | string, options: { timeoutMs?: number } = {}): this {
    return this.#expect(target, { kind: "hidden" }, options.timeoutMs);
  }

  expectText(
    target: Locator | string,
    expected: string,
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#expect(target, { kind: "text", expected }, options.timeoutMs);
  }

  expectContainsText(
    target: Locator | string,
    expected: string,
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#expect(target, { kind: "containText", expected }, options.timeoutMs);
  }

  expectValue(
    target: Locator | string,
    expected: string,
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#expect(target, { kind: "value", expected }, options.timeoutMs);
  }

  expectCount(
    target: Locator | string,
    expected: number,
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#expect(target, { kind: "count", expected }, options.timeoutMs);
  }

  expectAttribute(
    target: Locator | string,
    name: string,
    expected: string | null,
    options: { timeoutMs?: number } = {},
  ): this {
    return this.#expect(target, { kind: "attribute", name, expected }, options.timeoutMs);
  }

  /** Returns portable transaction IR without executing it. */
  compile(): readonly CompiledFlowStep[] {
    return this.#steps.map(({ spec, ...step }) => ({
      ...step,
      ...(spec ? { spec: compileLocator(spec) } : {}),
      args: structuredClone(step.args),
    }));
  }

  async run(options: { timeoutMs?: number } = {}): Promise<void> {
    const snapshot = this.#steps.map((step) => structuredClone(step));
    await this.page._runFlow(snapshot, options.timeoutMs);
  }

  #expect(target: Locator | string, args: Record<string, unknown>, timeoutMs?: number): this {
    return this.#push(target, "expect", args, timeoutMs);
  }

  #push(
    target: Locator | string,
    operation: FlowOperation,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): this {
    const locator = typeof target === "string" ? this.page.locator(target) : target;
    if (!(locator instanceof Locator) || locator.page !== this.page) {
      throw new Error("Flow locators must belong to the same page as the flow");
    }
    this.#steps.push({ operation, spec: locator.spec, args, timeoutMs });
    return this;
  }
}

function compileLocator(spec: LocatorSpec): CompiledLocatorSpec {
  const { name, hasText, parent, ...rest } = spec;
  return {
    ...rest,
    ...(typeof name === "string" ? { name } : {}),
    ...(name instanceof RegExp ? { nameRegex: { source: name.source, flags: name.flags } } : {}),
    ...(typeof hasText === "string" ? { hasText } : {}),
    ...(hasText instanceof RegExp
      ? { hasTextRegex: { source: hasText.source, flags: hasText.flags } }
      : {}),
    ...(parent ? { parent: compileLocator(parent) } : {}),
  };
}
