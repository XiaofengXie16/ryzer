import type { TestFixtures, TestFunction } from "./types.js";

export interface RegisteredTest {
  id: number;
  title: string;
  file: string;
  fn: TestFunction;
  skipped: boolean;
  only: boolean;
  beforeEach: Hook[];
  afterEach: Hook[];
}

type Hook = (fixtures: TestFixtures) => void | Promise<void>;

interface Suite {
  title: string;
  beforeEach: Hook[];
  afterEach: Hook[];
}

interface RegistryState {
  registry: RegisteredTest[];
  suites: Suite[];
  currentFile: string;
  nextId: number;
}

const registryKey = Symbol.for("ryzer.registry.v1");
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: RegistryState };
const state = (globalRegistry[registryKey] ??= {
  registry: [],
  suites: [],
  currentFile: "<unknown>",
  nextId: 1,
});

type TestCallable = {
  (title: string, fn: TestFunction): void;
  skip(title: string, fn: TestFunction): void;
  only(title: string, fn: TestFunction): void;
  flow(title: string, fn: TestFunction): void;
  describe(title: string, fn: () => void): void;
  beforeEach(fn: Hook): void;
  afterEach(fn: Hook): void;
};

function register(
  title: string,
  fn: TestFunction,
  options: { skipped?: boolean; only?: boolean } = {},
): void {
  state.registry.push({
    id: state.nextId++,
    title: [...state.suites.map((suite) => suite.title), title].join(" › "),
    file: state.currentFile,
    fn,
    skipped: options.skipped ?? false,
    only: options.only ?? false,
    beforeEach: state.suites.flatMap((suite) => suite.beforeEach),
    afterEach: state.suites.flatMap((suite) => suite.afterEach).reverse(),
  });
}

export const test = ((title: string, fn: TestFunction) => register(title, fn)) as TestCallable;
test.skip = (title, fn) => register(title, fn, { skipped: true });
test.only = (title, fn) => register(title, fn, { only: true });
test.flow = (title, fn) =>
  register(title, async (fixtures) => {
    await fixtures.page.transaction(async () => await fn(fixtures));
  });
test.describe = (title, fn) => {
  state.suites.push({ title, beforeEach: [], afterEach: [] });
  try {
    fn();
  } finally {
    state.suites.pop();
  }
};
test.beforeEach = (fn) => {
  const suite = state.suites.at(-1);
  if (!suite) throw new Error("test.beforeEach() must be declared inside test.describe()");
  suite.beforeEach.push(fn);
};
test.afterEach = (fn) => {
  const suite = state.suites.at(-1);
  if (!suite) throw new Error("test.afterEach() must be declared inside test.describe()");
  suite.afterEach.push(fn);
};

export function _setCurrentFile(file: string): void {
  state.currentFile = file;
}

export function _registeredTests(): RegisteredTest[] {
  return [...state.registry];
}

export function _resetRegistry(): void {
  state.registry.length = 0;
  state.suites.length = 0;
  state.currentFile = "<unknown>";
  state.nextId = 1;
}
