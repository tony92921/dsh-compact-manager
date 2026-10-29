/**
 * Behaviour tests for the trigger pane.
 *
 * The pane is the only place a user can see *when* automatic compaction will fire,
 * and every input it collects is silently ineffective if the resolved number is
 * wrong. Three claims need pinning:
 *
 * 1. The resolved trigger is rendered from the Host's answer, not recomputed here —
 *    a local copy of the formula would agree until the day it did not.
 * 2. The page says which limit won. "80%" and "25%" come from the same ratio, so a
 *    number without its cause is unreadable.
 * 3. An impossible configuration explains itself instead of showing 0 tok, because
 *    "never compacts" and "compacts at zero" look identical on a bare number.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = readFileSync(join(root, "lib", "client.js"), "utf8");

function makeReact() {
  const states = [];
  let cursor = 0;
  const refs = [];
  return {
    reset() { cursor = 0; },
    React: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: Symbol("Fragment"),
      Component: class {
        constructor(props) { this.props = props; this.state = {}; }
        setState(next) { Object.assign(this.state, next); }
      },
      useRef: (value) => {
        const index = cursor++;
        if (!(index in refs)) refs[index] = { current: value };
        return refs[index];
      },
      useState: (value) => {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof value === "function" ? value() : value;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useId: () => "id",
      useSyncExternalStore: (_subscribe, read) => read(),
      createContext: () => ({ Provider: null, Consumer: null })
    }
  };
}

function loadModule() {
  const harness = makeReact();
  const stubs = {
    react: harness.React,
    "react-dom": { createPortal: (node) => node },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: harness.React.Fragment }
  };
  const require = createRequire(import.meta.url);
  let registered;
  const run = new Function("window", "document", "require", bundle);
  run({
    __ModuleLoader__: { load: (definition) => { registered = definition; } }
  }, {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} }
  }, (specifier) => {
    if (specifier in stubs) return stubs[specifier];
    return require(specifier);
  });
  return { module: registered.factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unavailable module: ${specifier}`);
  }), harness };
}

/** Concatenate every string in a rendered tree. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  const own = Array.isArray(node.children) ? node.children.map(textOf).join("") : "";
  // Props carry copy too: hints, titles and aria labels are user-visible.
  const props = node.props ?? {};
  const fromProps = ["title", "aria-label"].map((key) => props[key]).filter((v) => typeof v === "string").join(" ");
  return own + " " + fromProps;
}

function expand(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  const children = Array.isArray(node.children) ? node.children.map(expand) : node.children;
  if (typeof node.type === "function") {
    return expand({ ...node, children, ...node.type({ ...node.props, children }) });
  }
  return { ...node, children };
}

const CONFIG = {
  thresholdOverride: true,
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  provider: "p",
  model: "m"
};

/**
 * The form helpers the pane renders with.
 *
 * `toggle` and `number` live inside `SettingsPanel` because they close over the
 * patch/save plumbing. The pane receives them as props, so the test has to supply
 * equivalents — deliberately the simplest thing that renders a label, a hint and
 * an input, so a copy change does not break the test.
 */
function makeHelpers() {
  const states = [];
  let cursor = 0;
  return {
    reset() { cursor = 0; },
    helpers: {
      toggle: (icon, label, hint, key) => ({
        type: "div",
        props: { "data-key": key, title: hint },
        children: [label, hint]
      }),
      number: (icon, label, hint, key, options) => ({
        type: "div",
        props: { "data-key": key, title: hint },
        children: [
          label,
          hint,
          { type: "input", props: { defaultValue: options?.fallback, step: options?.step }, children: [] }
        ]
      })
    }
  };
}

function render({ config = CONFIG, preview, saving = false } = {}) {
  const { module, harness } = loadModule();
  harness.reset();
  assert.equal(typeof module.TriggerPane, "function", "the bundle must export TriggerPane");
  const { helpers } = makeHelpers();
  const tree = expand(module.TriggerPane({
    config,
    patch: () => {},
    saving,
    preview,
    previewBusy: false,
    loadPreview: () => Promise.resolve(),
    save: () => Promise.resolve(),
    toggle: helpers.toggle,
    number: helpers.number
  }));
  return { tree, text: textOf(tree), module };
}

const RATIO_WINS = {
  spec: {
    known: true,
    contextWindow: 1_000_000,
    reservedTokens: 32_768,
    messageBudget: 967_232,
    headroomTokens: 65_536,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    byRatio: 800_000,
    byHeadroom: 901_696,
    thresholdTokens: 800_000,
    thresholdPercent: 80,
    cappedBy: "ratio",
    retainTokens: 154_757,
    retainClamped: false
  },
  model: { provider: "p", model: "m" }
};

const HEADROOM_WINS = {
  spec: {
    known: true,
    contextWindow: 131_072,
    reservedTokens: 32_768,
    messageBudget: 98_304,
    headroomTokens: 65_536,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    byRatio: 104_857,
    byHeadroom: 32_768,
    thresholdTokens: 32_768,
    thresholdPercent: 25,
    cappedBy: "headroom",
    retainTokens: 15_728,
    retainClamped: false
  },
  model: { provider: "p", model: "m" }
};

test("the resolved trigger and its percentage are shown", () => {
  const { text } = render({ preview: RATIO_WINS });
  assert.match(text, /800k/, "the token trigger must be visible");
  assert.match(text, /80\.0%/);
  assert.match(text, /窗口/);
  assert.match(text, /消息预算/);
});

test("the pane says which of the two limits decided the trigger", () => {
  const ratio = render({ preview: RATIO_WINS }).text;
  assert.match(ratio, /由触发线比例决定|窗口足够大/, "ratio-governed must be named as such");

  const headroom = render({ preview: HEADROOM_WINS }).text;
  assert.match(headroom, /预留空间/);
  assert.match(headroom, /25\.0%/);
  assert.match(headroom, /压低/, "the pane must explain why a small window fires early");
});

test("both candidates are printed so the comparison is checkable", () => {
  const { text } = render({ preview: HEADROOM_WINS });
  // formatTokens rounds to whole thousands above 10k, so 32,768 renders as 33k.
  assert.match(text, /105k/, "the losing ratio candidate stays visible");
  assert.match(text, /33k/, "the winning headroom candidate is shown");
});

test("an unknowable trigger explains itself instead of showing zero", () => {
  const { text } = render({ preview: { spec: { known: false, reason: "no-window" } } });
  assert.doesNotMatch(text, /^0 tok/);
  assert.match(text, /上下文窗口/, "the pane must say what is missing");
});

test("a headroom that eats the budget says so and points at the field", () => {
  const { text } = render({
    preview: {
      spec: {
        known: false,
        reason: "headroom-over-budget",
        headroomTokens: 80_000,
        messageBudget: 67_232
      }
    }
  });
  assert.match(text, /永远不会压缩/, "an impossible config must not read as idle");
  assert.match(text, /headroom/);
});

test("a retain ratio that would swallow the region is reported as clamped", () => {
  const clamped = {
    spec: {
      ...RATIO_WINS.spec,
      thresholdTokens: 150_000,
      thresholdPercent: 15,
      cappedBy: "ratio",
      retainTokens: 75_000,
      retainClamped: true
    }
  };
  const { text } = render({ preview: clamped });
  assert.match(text, /自动下调/, "the adjustment must be visible, not silent");
  assert.match(text, /75k/);
});

test("the override switch being off is stated, not implied", () => {
  const { text } = render({ config: { ...CONFIG, thresholdOverride: false }, preview: RATIO_WINS });
  assert.match(text, /接管开关已关闭|按本页数值试算/,
    "with the override off the numbers are a preview, and the page must say so");
});

test("before any answer arrives the pane does not claim a trigger", () => {
  const { text } = render({ preview: undefined });
  assert.match(text, /正在读取/);
});

test("a failed preview fetch surfaces the error rather than a stale number", () => {
  const { text } = render({ preview: { error: "读取失败" } });
  assert.match(text, /读取失败/);
});

test("the three inputs are rendered as editable fields", () => {
  const { tree } = render({ preview: RATIO_WINS });
  const inputs = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "input") inputs.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  assert.ok(inputs.length >= 3, `expected the three trigger inputs, got ${inputs.length}`);
});
