import type { Page } from "./page.js";
import type {
  ActionOptions,
  ClickOptions,
  FillOptions,
  LocatorSpec,
  WaitForOptions,
} from "./types.js";

export type Expectation =
  | { kind: "visible" | "hidden" }
  | { kind: "text" | "containText" | "value" | "count"; expected: string | number }
  | { kind: "attribute"; name: string; expected: string | null };

export const LOCATOR_BRAND = Symbol.for("ryzer.locator.v1");

export class Locator {
  readonly [LOCATOR_BRAND] = true;
  constructor(
    readonly page: Page,
    readonly spec: LocatorSpec,
  ) {}

  locator(selector: string): Locator {
    return new Locator(this.page, { kind: "css", value: selector, parent: this.spec });
  }

  getByText(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this.page, {
      kind: "text",
      value: text,
      exact: options.exact,
      parent: this.spec,
    });
  }

  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return new Locator(this.page, {
      kind: "role",
      value: role,
      name: options.name,
      exact: options.exact,
      parent: this.spec,
    });
  }

  getByLabel(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this.page, {
      kind: "label",
      value: text,
      exact: options.exact,
      parent: this.spec,
    });
  }

  getByPlaceholder(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this.page, {
      kind: "placeholder",
      value: text,
      exact: options.exact,
      parent: this.spec,
    });
  }

  getByTestId(testId: string): Locator {
    return new Locator(this.page, {
      kind: "testId",
      value: testId,
      attribute: this.page.context.options.testIdAttribute ?? "data-testid",
      parent: this.spec,
    });
  }

  filter(options: { hasText?: string | RegExp }): Locator {
    return new Locator(this.page, { ...this.spec, hasText: options.hasText });
  }

  nth(index: number): Locator {
    if (!Number.isInteger(index)) throw new Error("Locator index must be an integer");
    return new Locator(this.page, { ...this.spec, index });
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  async click(options: ClickOptions = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "click",
        spec: this.spec,
        args: { button: options.button ?? "left", clickCount: options.clickCount ?? 1 },
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    const point = await this.page._runLocator<{ x: number; y: number }>(
      this.spec,
      "actionable",
      {},
      options.timeoutMs,
    );
    await this.page._click(point.x, point.y, options.button ?? "left", options.clickCount ?? 1);
  }

  async dblclick(options: Omit<ClickOptions, "clickCount"> = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "dblclick",
        spec: this.spec,
        args: { button: options.button ?? "left" },
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    const point = await this.page._runLocator<{ x: number; y: number }>(
      this.spec,
      "actionable",
      {},
      options.timeoutMs,
    );
    await this.page._click(point.x, point.y, options.button ?? "left", 1);
    await this.page._click(point.x, point.y, options.button ?? "left", 2);
  }

  async fill(value: string, options: FillOptions = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "fill",
        spec: this.spec,
        args: { value },
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    await this.page._runLocator(this.spec, "fill", { value }, options.timeoutMs);
  }

  async hover(options: ActionOptions = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "hover",
        spec: this.spec,
        args: {},
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    const point = await this.page._runLocator<{ x: number; y: number }>(
      this.spec,
      "actionable",
      {},
      options.timeoutMs,
    );
    await this.page._hover(point.x, point.y);
  }

  async focus(options: ActionOptions = {}): Promise<void> {
    await this.page._runLocator(this.spec, "focus", {}, options.timeoutMs);
  }

  async press(key: string, options: ActionOptions = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "press",
        spec: this.spec,
        args: { key },
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    await this.focus(options);
    await this.page._press(key);
  }

  async selectOption(value: string | string[], options: ActionOptions = {}): Promise<string[]> {
    return await this.page._runLocator(this.spec, "select", { values: value }, options.timeoutMs);
  }

  async isChecked(options: ActionOptions = {}): Promise<boolean> {
    return await this.page._runLocator(this.spec, "checked", {}, options.timeoutMs);
  }

  async check(options: ClickOptions = {}): Promise<void> {
    if (!(await this.isChecked(options))) await this.click(options);
    if (!(await this.isChecked(options))) throw new Error("Checkbox did not become checked");
  }

  async uncheck(options: ClickOptions = {}): Promise<void> {
    if (await this.isChecked(options)) await this.click(options);
    if (await this.isChecked(options)) throw new Error("Checkbox did not become unchecked");
  }

  async waitFor(options: WaitForOptions = {}): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "state",
        spec: this.spec,
        args: { state: options.state ?? "visible" },
        timeoutMs: options.timeoutMs,
      })
    )
      return;
    await this.page._runLocator(
      this.spec,
      "state",
      { state: options.state ?? "visible" },
      options.timeoutMs,
    );
  }

  async textContent(options: ActionOptions = {}): Promise<string> {
    return await this.page._runLocator(this.spec, "text", {}, options.timeoutMs);
  }

  async innerText(options: ActionOptions = {}): Promise<string> {
    return await this.page._runLocator(this.spec, "innerText", {}, options.timeoutMs);
  }

  async isVisible(options: ActionOptions = {}): Promise<boolean> {
    return await this.page._runLocator(this.spec, "visible", {}, options.timeoutMs);
  }

  async count(): Promise<number> {
    return await this.page._runLocator(this.spec, "count");
  }

  async getAttribute(name: string, options: ActionOptions = {}): Promise<string | null> {
    return await this.page._runLocator(this.spec, "attribute", { name }, options.timeoutMs);
  }

  async _expect(expectation: Expectation, timeoutMs?: number): Promise<void> {
    if (
      this.page._recordTransactionStep({
        operation: "expect",
        spec: this.spec,
        args: expectation as unknown as Record<string, unknown>,
        timeoutMs,
      })
    )
      return;
    await this.page._runLocator(
      this.spec,
      "expect",
      expectation as unknown as Record<string, unknown>,
      timeoutMs,
    );
  }
}
