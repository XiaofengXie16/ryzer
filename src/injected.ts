// This function is serialized and installed in every document. Keeping locator
// retries in the renderer collapses dozens of protocol calls into one.
export function installRyzerRuntime(): void {
  const root = globalThis as typeof globalThis & { __ryzer?: unknown };
  if (root.__ryzer) return;

  type SerializedSpec = {
    kind: "css" | "text" | "role" | "label" | "placeholder" | "testId";
    value: string;
    exact?: boolean;
    name?: string;
    nameRegex?: { source: string; flags: string };
    attribute?: string;
    parent?: SerializedSpec;
    index?: number;
    hasText?: string;
    hasTextRegex?: { source: string; flags: string };
  };
  type ElementResult = { element: Element; count: number };
  type Result = { ok: boolean; value?: unknown; error?: string };
  type FlowStep = {
    operation:
      | "fill"
      | "click"
      | "dblclick"
      | "hover"
      | "press"
      | "select"
      | "state"
      | "expect"
      | "advanceTime";
    spec?: SerializedSpec;
    args: Record<string, unknown>;
    timeoutMs: number;
  };
  const activeOperations = new Set<(reason: string) => void>();
  const mutationWakeups = new Set<() => void>();
  const mutationObserver = new MutationObserver(() => {
    for (const wake of mutationWakeups) queueMicrotask(wake);
  });
  mutationObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const flows = new Map<number, { steps: FlowStep[]; cursor: number }>();
  let nextFlowId = 1;

  // Maintain the open-shadow topology once per realm. Query operations still
  // resolve fresh elements every time; this only avoids rescanning the entire
  // light DOM merely to rediscover the same shadow hosts.
  const openShadowRoots = new Set<ShadowRoot>();
  const registerExistingShadowRoots = (scope: Document | ShadowRoot) => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      if (!element.shadowRoot || openShadowRoots.has(element.shadowRoot)) continue;
      openShadowRoots.add(element.shadowRoot);
      registerExistingShadowRoots(element.shadowRoot);
    }
  };
  registerExistingShadowRoots(document);
  const attachShadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  const nativeAttachShadow = Element.prototype.attachShadow;
  const trackedAttachShadow = new Proxy(nativeAttachShadow, {
    apply(target, receiver, args: [ShadowRootInit]) {
      const shadow = Reflect.apply(target, receiver, args) as ShadowRoot;
      if (args[0]?.mode === "open") openShadowRoots.add(shadow);
      return shadow;
    },
  });
  Object.defineProperty(Element.prototype, "attachShadow", {
    ...attachShadowDescriptor,
    value: trackedAttachShadow,
  });

  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const fatal = (message: string): never => {
    const error = new Error(message);
    error.name = "RyzerFatal";
    throw error;
  };
  const implicitRole = (element: Element): string | null => {
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (
      tag === "h1" ||
      tag === "h2" ||
      tag === "h3" ||
      tag === "h4" ||
      tag === "h5" ||
      tag === "h6"
    ) {
      return "heading";
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["email", "search", "tel", "text", "url", "password"].includes(type)) return "textbox";
      if (type === "range") return "slider";
    }
    return null;
  };
  const elementById = (element: Element, id: string): Element | null => {
    const owner = element.getRootNode();
    if (owner instanceof Document) return owner.getElementById(id);
    if (owner instanceof ShadowRoot) return owner.querySelector(`#${CSS.escape(id)}`);
    return document.getElementById(id);
  };
  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => elementById(element, id)?.textContent ?? "")
        .join(" ");
      if (normalize(text)) return normalize(text);
    }
    const aria = element.getAttribute("aria-label");
    if (aria) return normalize(aria);
    if (element instanceof HTMLInputElement && element.id) {
      const labels = element.labels;
      if (labels?.length)
        return normalize(
          Array.from(labels)
            .map((label) => label.textContent)
            .join(" "),
        );
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) return normalize(wrappingLabel.textContent);
    if (element instanceof HTMLInputElement) return normalize(element.value || element.placeholder);
    if (element instanceof HTMLImageElement) return normalize(element.alt);
    return normalize(element.textContent);
  };
  const matchesName = (actual: string, spec: SerializedSpec): boolean => {
    if (spec.nameRegex) return new RegExp(spec.nameRegex.source, spec.nameRegex.flags).test(actual);
    if (spec.name === undefined) return true;
    return spec.exact
      ? actual === normalize(spec.name)
      : actual.toLowerCase().includes(normalize(spec.name).toLowerCase());
  };
  const matchesText = (actual: string, wanted: string, exact?: boolean): boolean => {
    const normalizedActual = normalize(actual);
    const normalizedWanted = normalize(wanted);
    return exact
      ? normalizedActual === normalizedWanted
      : normalizedActual.toLowerCase().includes(normalizedWanted.toLowerCase());
  };
  const shadowBelongsTo = (shadow: ShadowRoot, scope: Document | ShadowRoot | Element): boolean => {
    if (!shadow.host.isConnected) {
      openShadowRoots.delete(shadow);
      return false;
    }
    if (scope instanceof Document) return shadow.host.ownerDocument === scope;
    let node: Element = shadow.host;
    for (;;) {
      if (node === scope || scope.contains(node)) return true;
      const owner = node.getRootNode();
      if (!(owner instanceof ShadowRoot)) return false;
      node = owner.host;
    }
  };
  const queryRoots = (
    scope: Document | ShadowRoot | Element,
  ): Array<Document | ShadowRoot | Element> => [
    scope,
    ...Array.from(openShadowRoots).filter(
      (shadow) => shadow !== scope && shadowBelongsTo(shadow, scope),
    ),
  ];
  const cssElements = (scope: Document | ShadowRoot | Element, selector: string): Element[] => {
    try {
      return queryRoots(scope).flatMap((root) => Array.from(root.querySelectorAll(selector)));
    } catch {
      return fatal(`Invalid CSS selector: ${selector}`);
    }
  };
  const query = (
    spec: SerializedSpec,
    baseScopes: Array<Document | ShadowRoot | Element> = [document],
  ): Element[] => {
    const scopes: Array<Document | ShadowRoot | Element> = spec.parent
      ? query(spec.parent)
      : baseScopes;
    const found: Element[] = [];
    for (const scope of scopes) {
      if (spec.kind === "css") {
        found.push(...cssElements(scope, spec.value));
        continue;
      }
      const candidateSelector =
        spec.kind === "role"
          ? "[role],button,a[href],select,textarea,img,h1,h2,h3,h4,h5,h6,input"
          : spec.kind === "label"
            ? "input,textarea,select,button,output,meter,progress"
            : spec.kind === "placeholder"
              ? "[placeholder]"
              : spec.kind === "testId"
                ? `[${CSS.escape(spec.attribute ?? "data-testid")}]`
                : "*";
      const all = cssElements(scope, candidateSelector);
      if (spec.kind === "role") {
        found.push(
          ...all.filter((element) => {
            const role = element.getAttribute("role") ?? implicitRole(element);
            return (
              role === spec.value &&
              matchesName(accessibleName(element), spec) &&
              isVisible(element)
            );
          }),
        );
      } else if (spec.kind === "label") {
        found.push(
          ...all.filter((element) => {
            if (
              !(
                element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement ||
                element instanceof HTMLSelectElement ||
                element instanceof HTMLButtonElement ||
                element instanceof HTMLOutputElement ||
                element instanceof HTMLMeterElement ||
                element instanceof HTMLProgressElement
              )
            )
              return false;
            const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
            const labelText = labels?.length
              ? Array.from(labels)
                  .map((label) => label.textContent ?? "")
                  .join(" ")
              : element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")
                ? accessibleName(element)
                : "";
            return Boolean(labelText) && matchesText(labelText, spec.value, spec.exact);
          }),
        );
      } else if (spec.kind === "placeholder") {
        found.push(
          ...all.filter((element) =>
            matchesText(element.getAttribute("placeholder") ?? "", spec.value, spec.exact),
          ),
        );
      } else if (spec.kind === "testId") {
        found.push(
          ...all.filter(
            (element) => element.getAttribute(spec.attribute ?? "data-testid") === spec.value,
          ),
        );
      } else {
        const matches = (element: Element) =>
          matchesText(element.textContent ?? "", spec.value, spec.exact);
        // Return the deepest matching elements, which mirrors what users mean
        // by "the element containing this text".
        found.push(
          ...all.filter(
            (element) => matches(element) && !Array.from(element.children).some(matches),
          ),
        );
      }
    }
    let result = [...new Set(found)];
    if (spec.hasText !== undefined)
      result = result.filter((element) =>
        matchesText(element.textContent ?? "", spec.hasText!, false),
      );
    if (spec.hasTextRegex) {
      result = result.filter((element) =>
        new RegExp(spec.hasTextRegex!.source, spec.hasTextRegex!.flags).test(
          normalize(element.textContent),
        ),
      );
    }
    if (spec.index !== undefined) {
      const index = spec.index < 0 ? result.length + spec.index : spec.index;
      result = result[index] ? [result[index]!] : [];
    }
    return result;
  };
  const isVisible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const disabled = (element: Element): boolean => {
    if (element.getAttribute("aria-disabled") === "true") return true;
    return element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement
      ? element.disabled
      : false;
  };
  const selectOne = (spec: SerializedSpec, strict = true): ElementResult | null => {
    const elements = query(spec);
    if (strict && elements.length > 1) fatal(`Strict locator matched ${elements.length} elements`);
    return elements[0] ? { element: elements[0], count: elements.length } : null;
  };
  const rectKey = (rect: DOMRect) =>
    [rect.x, rect.y, rect.width, rect.height].map((n) => n.toFixed(2)).join(":");

  const run = async (
    spec: SerializedSpec,
    operation: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Result> => {
    const deadline = performance.now() + timeoutMs;
    let previousRect = "";
    let stableFrames = 0;
    let lastError = "";

    return await new Promise<Result>((resolve) => {
      let settled = false;
      let frame = 0;
      let framePending = false;
      let cancel: (reason: string) => void;
      let wake: () => void;
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        activeOperations.delete(cancel);
        mutationWakeups.delete(wake);
        cancelAnimationFrame(frame);
        resolve(result);
      };
      cancel = (reason) => finish({ ok: false, error: reason });
      activeOperations.add(cancel);
      const scheduleFrame = () => {
        if (framePending || settled) return;
        framePending = true;
        frame = requestAnimationFrame(() => {
          framePending = false;
          check(true);
        });
      };
      const check = (paintSample = false) => {
        if (settled) return;
        try {
          const elements = query(spec);
          const element = elements[0];
          const strict =
            operation !== "count" && !(operation === "expect" && args.kind === "count");
          if (strict && elements.length > 1)
            fatal(`Strict locator matched ${elements.length} elements`);

          if (operation === "count") return finish({ ok: true, value: elements.length });
          if (operation === "state") {
            const state = String(args.state ?? "visible");
            const present = Boolean(element);
            const visible = element ? isVisible(element) : false;
            if (
              (state === "attached" && present) ||
              (state === "detached" && !present) ||
              (state === "visible" && visible) ||
              (state === "hidden" && (!present || !visible))
            ) {
              return finish({ ok: true });
            }
          } else if (operation === "expect") {
            const kind = String(args.kind);
            let pass = false;
            let actual: unknown;
            if (kind === "count") {
              actual = elements.length;
              pass = actual === args.expected;
            } else if (kind === "hidden") {
              actual = element ? isVisible(element) : false;
              pass = actual === false;
            } else if (element) {
              if (kind === "visible") {
                actual = isVisible(element);
                pass = actual === true;
              } else if (kind === "text" || kind === "containText") {
                actual = normalize(element.textContent);
                pass =
                  kind === "text"
                    ? actual === normalize(String(args.expected))
                    : String(actual).includes(String(args.expected));
              } else if (kind === "value") {
                actual =
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement ||
                  element instanceof HTMLSelectElement
                    ? element.value
                    : element.getAttribute("value");
                pass = actual === args.expected;
              } else if (kind === "attribute") {
                actual = element.getAttribute(String(args.name));
                pass = actual === args.expected;
              }
            }
            lastError = `expected ${kind} ${JSON.stringify(args.expected ?? true)}, received ${JSON.stringify(actual)}`;
            if (pass) return finish({ ok: true, value: actual });
          } else if (element) {
            if (operation === "text")
              return finish({ ok: true, value: normalize(element.textContent) });
            if (operation === "innerText")
              return finish({ ok: true, value: (element as HTMLElement).innerText });
            if (operation === "visible") return finish({ ok: true, value: isVisible(element) });
            if (operation === "attribute")
              return finish({ ok: true, value: element.getAttribute(String(args.name)) });
            if (operation === "checked") {
              if (
                element instanceof HTMLInputElement &&
                (element.type === "checkbox" || element.type === "radio")
              ) {
                return finish({ ok: true, value: element.checked });
              }
              const role = element.getAttribute("role");
              if (
                [
                  "checkbox",
                  "menuitemcheckbox",
                  "option",
                  "radio",
                  "switch",
                  "menuitemradio",
                  "treeitem",
                ].includes(role ?? "")
              ) {
                return finish({ ok: true, value: element.getAttribute("aria-checked") === "true" });
              }
              fatal("Element is not a checkbox or radio button");
            }
            if (operation === "focus") {
              if (!isVisible(element) || disabled(element))
                throw new Error("Element cannot be focused");
              (element as HTMLElement).focus();
              return finish({ ok: true });
            }
            if (operation === "select") {
              if (!isVisible(element) || disabled(element))
                throw new Error("Element is not selectable");
              if (!(element instanceof HTMLSelectElement)) fatal("Element is not a select");
              const select = element as HTMLSelectElement;
              const values = Array.isArray(args.values)
                ? args.values.map(String)
                : [String(args.values)];
              let matched = 0;
              for (const option of Array.from(select.options)) {
                option.selected = values.includes(option.value);
                if (option.selected) matched++;
              }
              if (!matched) throw new Error(`No option matched ${values.join(", ")}`);
              select.dispatchEvent(new Event("input", { bubbles: true }));
              select.dispatchEvent(new Event("change", { bubbles: true }));
              return finish({
                ok: true,
                value: Array.from(select.selectedOptions).map((option) => option.value),
              });
            }
            if (operation === "fill") {
              if (!isVisible(element) || disabled(element))
                throw new Error("Element is not fillable");
              const value = String(args.value ?? "");
              if (element instanceof HTMLElement && element.isContentEditable) {
                element.focus();
                element.textContent = value;
                element.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    composed: true,
                    inputType: "insertText",
                    data: value,
                  }),
                );
                return finish({ ok: true });
              }
              if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
                fatal("Element is not fillable");
              const fillable = element as HTMLInputElement | HTMLTextAreaElement;
              if (fillable instanceof HTMLInputElement) {
                const rejected = [
                  "button",
                  "checkbox",
                  "file",
                  "image",
                  "radio",
                  "reset",
                  "submit",
                ];
                if (rejected.includes(fillable.type))
                  fatal(`Input of type ${fillable.type} cannot be filled`);
              }
              const prototype =
                fillable instanceof HTMLInputElement
                  ? HTMLInputElement.prototype
                  : HTMLTextAreaElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
              setter?.call(fillable, value);
              if (fillable.value !== value)
                fatal(
                  `Malformed value ${JSON.stringify(value)} for input type ${fillable instanceof HTMLInputElement ? fillable.type : "textarea"}`,
                );
              fillable.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  composed: true,
                  inputType: "insertText",
                  data: value,
                }),
              );
              fillable.dispatchEvent(new Event("change", { bubbles: true }));
              return finish({ ok: true });
            }
            if (operation === "actionable") {
              if (!isVisible(element)) throw new Error("Element is not visible");
              if (disabled(element)) throw new Error("Element is disabled");
              const style = getComputedStyle(element);
              if (style.pointerEvents === "none")
                throw new Error("Element does not receive pointer events");
              element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
              const rect = element.getBoundingClientRect();
              const currentRect = rectKey(rect);
              if (paintSample) stableFrames = currentRect === previousRect ? stableFrames + 1 : 0;
              else if (previousRect && currentRect !== previousRect) stableFrames = 0;
              previousRect = currentRect;
              if (stableFrames >= 1) {
                const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
                const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
                let hit = document.elementFromPoint(x, y);
                while (hit?.shadowRoot) {
                  const innerHit = hit.shadowRoot.elementFromPoint(x, y);
                  if (!innerHit || innerHit === hit) break;
                  hit = innerHit;
                }
                if (hit && (hit === element || element.contains(hit) || hit.contains(element))) {
                  return finish({ ok: true, value: { x, y } });
                }
                throw new Error("Element is covered by another element");
              }
            }
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (error instanceof Error && error.name === "RyzerFatal")
            return finish({ ok: false, error: lastError });
        }
        if (performance.now() >= deadline) {
          return finish({
            ok: false,
            error: `${lastError || `Locator did not become ready`}: ${spec.kind}=${spec.value}`,
          });
        }
        scheduleFrame();
      };
      wake = () => check(false);
      mutationWakeups.add(wake);
      check(false);
    });
  };

  const executeFlow = async (flowId: number) => {
    const flow = flows.get(flowId);
    if (!flow)
      return { ok: false, flowId, cursor: -1, error: `Unknown or completed flow ${flowId}` };
    const { steps } = flow;
    let cursor = flow.cursor;
    while (cursor < steps.length) {
      const step = steps[cursor]!;
      if (step.operation === "advanceTime") {
        flow.cursor = cursor + 1;
        return {
          ok: true,
          flowId,
          cursor: cursor + 1,
          input: { kind: "advanceTime", milliseconds: Number(step.args.milliseconds) },
        };
      }
      if (!step.spec) {
        flows.delete(flowId);
        return { ok: false, flowId, cursor, error: `Flow step ${cursor} has no locator` };
      }
      if (
        step.operation === "click" ||
        step.operation === "dblclick" ||
        step.operation === "hover"
      ) {
        const readiness = await run(step.spec, "actionable", {}, step.timeoutMs);
        if (!readiness.ok) {
          flows.delete(flowId);
          return { ...readiness, flowId, cursor };
        }
        const point = readiness.value as { x: number; y: number };
        flow.cursor = cursor + 1;
        return {
          ok: true,
          flowId,
          cursor: cursor + 1,
          input:
            step.operation === "hover"
              ? { kind: "hover", ...point }
              : {
                  kind: step.operation,
                  ...point,
                  button: String(step.args.button ?? "left"),
                  clickCount: Number(step.args.clickCount ?? 1),
                },
        };
      }
      if (step.operation === "press") {
        const readiness = await run(step.spec, "focus", {}, step.timeoutMs);
        if (!readiness.ok) {
          flows.delete(flowId);
          return { ...readiness, flowId, cursor };
        }
        flow.cursor = cursor + 1;
        return {
          ok: true,
          flowId,
          cursor: cursor + 1,
          input: { kind: "press", key: String(step.args.key) },
        };
      }
      const result = await run(step.spec, step.operation, step.args, step.timeoutMs);
      if (!result.ok) {
        flows.delete(flowId);
        return { ...result, flowId, cursor };
      }
      cursor++;
      flow.cursor = cursor;
    }
    flows.delete(flowId);
    return { ok: true, flowId, cursor };
  };

  const beginFlow = (steps: FlowStep[]) => {
    const flowId = nextFlowId++;
    flows.set(flowId, { steps, cursor: 0 });
    return executeFlow(flowId);
  };

  const resumeFlow = (flowId: number) => executeFlow(flowId);

  const cancelFlow = (flowId: number) => flows.delete(flowId);

  root.__ryzer = {
    run,
    beginFlow,
    resumeFlow,
    cancelFlow,
    query: selectOne,
    cancelAll(reason = "Locator operation canceled") {
      for (const cancel of activeOperations) cancel(reason);
      flows.clear();
    },
  };
}

// tsx/esbuild annotates nested function names with a tiny __name helper when
// running TypeScript directly. Defining the no-op here keeps the serialized
// renderer bundle valid both before and after tsc compilation.
export const INJECTED_RUNTIME = `(()=>{const __name=(target)=>target;return (${installRyzerRuntime.toString()})()})()`;
