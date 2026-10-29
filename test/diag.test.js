/**
 * Behaviour tests for the diagnostics pane.
 *
 * The pane is a wall of numbers with no actions, so nothing throws when it is
 * wrong — it just quietly reports the wrong thing. Two mistakes are worth a test
 * each, because both already happened once:
 *
 * 1. It counted only folds, so the model path looked like it never ran.
 * 2. It summed manual folds with `replaceDefault` takeovers into one cell, which
 *    hid whether that setting had ever done anything.
 *
 * A third failure mode is structural: the pane reads Host fields directly, so a
 * missing key throws during render and React answers by unmounting the whole
 * settings dialog. `DiagGroups` therefore has to tolerate an older payload, and
 * the last test pins that.
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

/**
 * Expand function components so their children become walkable, but stop at
 * `DiagCell`: its props are the assertion surface, and expanding it would replace
 * them with a plain div.
 */
function expand(node, cells = []) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, cells));
  const children = Array.isArray(node.children) ? node.children.map((child) => expand(child, cells)) : node.children;
  if (typeof node.type === "function") {
    if (node.type.name === "DiagCell") {
      cells.push(node.props);
      return node;
    }
    return expand({ ...node, children, ...node.type({ ...node.props, children }) }, cells);
  }
  return { ...node, children };
}

const HEALTH = {
  version: "1.0.0",
  sessionApi: "eventAt",
  ingress: { ok: true, shaped: 12, snapped: 3, savedTokens: 84000, failures: 0, lastError: "" },
  shaping: { ok: true, shaped: 12, snapped: 3, savedTokens: 84000, failures: 0, lastError: "" },
  compaction: {
    model: {
      compactions: 9,
      failures: 1,
      savedTokens: 240000,
      lastBefore: 180000,
      lastAfter: 45000,
      last: {
        provider: "workbuddy",
        model: "space-bunny",
        reasoningEffort: "low",
        at: 1793243688687,
        fellBack: false,
        failedProvider: "",
        failedModel: ""
      }
    },
    mechanical: { manual: 2, replaced: 5, live: 4 }
  },
  hook: { live: 4, wrapped: 16, mechanicalFolds: 2, replacedFolds: 5, unsupported: 0, unsupportedEngines: [] },
  config: {}
};

/** Render the pane and return its cells keyed by label. */
function render(health) {
  const { module, harness } = loadModule();
  harness.reset();
  // DiagGroups is a module-level component; the pane calls it the same way.
  const DiagGroups = module.DiagGroups;
  assert.equal(typeof DiagGroups, "function", "the bundle must export DiagGroups for this test");
  const cells = [];
  harness.reset();
  const tree = expand(DiagGroups({ health }), cells);
  return {
    cells,
    tree,
    // The last-model row is not a DiagCell (it is full-width), so its text can only
    // be asserted on the rendered tree.
    text: textOf(tree),
    byLabel: new Map(cells.map((cell) => [cell.label, cell]))
  };
}

/** Concatenate every string, number and user-visible prop in a rendered tree. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const own = Array.isArray(node.children) ? node.children.map(textOf).join(" ") : "";
  const props = node.props ?? {};
  const fromProps = ["title", "aria-label"].map((key) => props[key]).filter((v) => typeof v === "string").join(" ");
  return own + " " + fromProps;
}

test("the pane reports the model path, not only folds", () => {
  const { byLabel } = render(HEALTH);
  assert.equal(byLabel.get("压缩次数")?.value, "9");
  assert.equal(byLabel.get("失败")?.value, "1");
  assert.equal(byLabel.get("共省")?.value, "240k tok");
  assert.equal(byLabel.get("最近一次")?.value, "180k → 45k tok");
});

test("manual folds and replaceDefault takeovers are separate cells", () => {
  const { byLabel } = render(HEALTH);
  assert.equal(byLabel.get("手动折页")?.value, "2");
  assert.equal(byLabel.get("接管折页")?.value, "5");
  // The summed value the old pane showed must not exist as a label any more.
  assert.equal(byLabel.has("机械折页"), false, "the merged counter must be gone");
});

test("the pane names the model that produced the last summary", () => {
  const { text } = render(HEALTH);
  assert.match(text, /上次用的模型/, "the row must be labelled");
  assert.match(text, /workbuddy\/space-bunny/, "the provider/model pair must be shown in full");
  assert.match(text, /low/, "the reasoning level belongs with the model it applied to");
});

test("a recorded fallback names both models rather than only the survivor", () => {
  const { text } = render({
    ...HEALTH,
    compaction: {
      ...HEALTH.compaction,
      model: {
        ...HEALTH.compaction.model,
        last: {
          provider: "q",
          model: "backup",
          reasoningEffort: "",
          at: 1793243688687,
          fellBack: true,
          failedProvider: "p",
          failedModel: "primary"
        }
      }
    }
  });
  assert.match(text, /q\/backup/, "the model that answered");
  assert.match(text, /p\/primary/, "the model that failed");
  assert.match(text, /备用模型/, "the fallback must be stated, not implied");
});

test("before any run the last-model row says so instead of showing a blank", () => {
  const { text } = render({
    ...HEALTH,
    compaction: {
      ...HEALTH.compaction,
      model: {
        ...HEALTH.compaction.model,
        last: { provider: "", model: "", reasoningEffort: "", at: 0, fellBack: false }
      }
    }
  });
  assert.match(text, /上次用的模型/);
  assert.match(text, /尚未运行/);
});

test("every cell carries a hover description", () => {
  const { cells } = render(HEALTH);
  assert.ok(cells.length >= 12, `expected both groups, got ${cells.length}`);
  for (const cell of cells) {
    assert.ok(typeof cell.title === "string" && cell.title.length > 8, `cell "${cell.label}" needs a real title`);
  }
});

test("a failing ingress pass is marked bad, not merely counted", () => {
  const { byLabel } = render({
    ...HEALTH,
    sessionApi: "events",
    shaping: { ...HEALTH.shaping, ok: false, failures: 2, lastError: "surface op rejected" }
  });
  assert.equal(byLabel.get("定形失败")?.bad, true);
  assert.equal(byLabel.get("定形失败")?.value, "2");
  assert.equal(byLabel.get("状态")?.value, "失败");
  assert.equal(byLabel.get("状态")?.bad, true);
  assert.equal(byLabel.get("会话 API")?.value, "events(旧)");
  assert.equal(byLabel.get("会话 API")?.bad, true);
});

test("the last-run cell says so instead of showing 0 → 0 before any model run", () => {
  const { byLabel } = render({
    ...HEALTH,
    compaction: { ...HEALTH.compaction, model: { ...HEALTH.compaction.model, compactions: 0, lastBefore: 0, lastAfter: 0 } }
  });
  assert.equal(byLabel.get("最近一次")?.value, "尚未运行");
});

test("a payload without the new groups still renders", () => {
  // A browser tab can outlive a Host restart; an old payload must not throw,
  // because a render throw unmounts the entire settings dialog. This is the
  // pre-split shape: no `compaction.model`, no `compaction.mechanical`.
  const { byLabel } = render({
    version: "1.0.0",
    sessionApi: "eventAt",
    ingress: { ok: true, shaped: 0, snapped: 0, savedTokens: 0, failures: 0, lastError: "" },
    hook: { live: 2, wrapped: 0, mechanicalFolds: 0, replacedFolds: 0, unsupported: 0, unsupportedEngines: [] },
    config: {}
  });
  assert.equal(byLabel.get("钩住引擎")?.value, "0", "a missing group renders zero, not a throw");
  assert.equal(byLabel.get("压缩次数")?.value, "0");
  assert.equal(byLabel.get("已定形")?.value, "0");
});
