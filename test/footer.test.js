/**
 * Behaviour tests for the popup footer.
 *
 * The footer is the plugin's whole visible surface now that the composer bolt is
 * gone, and its two buttons are wired to different Host actions. A mistake here is
 * silent: the wrong action posts, nothing throws, and the user reads the result as
 * "the feature does not work". These tests drive the real component through the
 * stub React in `probe-client.mjs`'s style and assert what each click posts.
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

/**
 * React stand-in with working state.
 *
 * `useState` returns the current slot value and a setter that writes it, so a
 * component can be called again to observe the effect of its own click — which is
 * exactly what an arming confirmation does.
 */
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

/** Load the bundle and return its registered module. */
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

/** Find the first rendered element matching `predicate`, depth-first. */
function find(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  if (Array.isArray(node.children)) return find(node.children, predicate);
  return undefined;
}

/** React elements are plain objects here; text is either a child or nested. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children ?? []);
}

const baseState = {
  available: true,
  engine: "saviour",
  config: { confirmFold: true, provider: "p", model: "m" },
  job: { phase: "idle", message: "", failures: 0 }
};

/** Collect every button element in a rendered tree. */
function buttonsOf(tree) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "button") found.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  return found;
}

/**
 * Mount the footer with real click → re-render behaviour.
 *
 * React re-renders on `setState`; the stub only stores the value. So each click
 * is followed by a fresh render, and the returned accessors always read the
 * *current* buttons. Without this, an arming click would appear to do nothing
 * because the caller keeps holding the pre-click element.
 */
function mountFooter({ confirmFold = true, module, harness, state: override } = {}) {
  const posted = [];
  const act = (action) => { posted.push(action); return Promise.resolve(); };
  const state = override ?? { ...baseState, config: { ...baseState.config, confirmFold } };
  let tree = (harness.reset(), module.CompactFooter({ state, sending: false, error: "", act }));
  const rerender = () => {
    harness.reset();
    tree = module.CompactFooter({ state, sending: false, error: "", act });
    return tree;
  };
  return {
    posted,
    get buttons() { return buttonsOf(tree); },
    get text() { return textOf(tree); },
    /** Click button `index` and let the component settle like React would. */
    click(index) {
      const button = buttonsOf(tree)[index];
      assert.ok(button, `button ${index} must exist`);
      button.props.onClick();
      return rerender();
    }
  };
}

test("the footer renders exactly the two manual buttons", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({ module, harness });
  assert.equal(footer.buttons.length, 2, "one model button and one mechanical button");
  const labels = footer.buttons.map((button) => textOf(button));
  assert.ok(labels[0].includes("手动压缩"), `first button: ${labels[0]}`);
  assert.ok(labels[1].includes("手动非模型压缩"), `second button: ${labels[1]}`);
});

test("each button posts its own action", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({ module, harness });

  footer.click(0);
  assert.deepEqual(footer.posted, ["configured"], "the first button is the model path");

  // The second button needs its confirmation click when confirmFold is on.
  footer.click(1);
  footer.click(1);
  assert.deepEqual(footer.posted, ["configured", "mechanical"], "the second button is the local fold");
});

test("confirmFold turns the second button into a two-click action", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({ confirmFold: true, module, harness });

  footer.click(1);
  assert.deepEqual(footer.posted, [], "the first click only arms the button");
  assert.equal(footer.buttons[1].props["data-armed"], "1", "an armed button must say so");
  assert.match(textOf(footer.buttons[1]), /再点一次确认折页/);

  footer.click(1);
  assert.deepEqual(footer.posted, ["mechanical"], "the second click commits");
});

test("the first button is never gated by confirmFold", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({ confirmFold: true, module, harness });
  footer.click(0);
  assert.deepEqual(footer.posted, ["configured"], "the model path is reversible enough to need no arming");
});

test("a disabled confirmation folds on the first click", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({ confirmFold: false, module, harness });
  footer.click(1);
  assert.deepEqual(footer.posted, ["mechanical"], "no arming when the setting is off");
  assert.equal(footer.buttons[1].props["data-armed"], undefined);
});

test("the fold button stays available with no model configured", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({
    module,
    harness,
    state: {
      available: true,
      engine: "ledger",
      config: { confirmFold: false, provider: "", model: "" },
      job: { phase: "idle", message: "", failures: 0 }
    }
  });
  assert.equal(footer.buttons[1].props.disabled, false, "the local fold must not depend on a model");
  footer.click(1);
  assert.deepEqual(footer.posted, ["mechanical"]);
});

test("both manual buttons are disabled while a job runs, and cancel stays live", () => {
  const { module, harness } = loadModule();
  const footer = mountFooter({
    module,
    harness,
    state: { ...baseState, job: { phase: "running", message: "正在机械折页…", failures: 0 } }
  });
  const labels = footer.buttons.map((button) => textOf(button));
  // The two screenshot-visible actions must not start a second job while one runs.
  for (const index of [0, 1]) {
    assert.equal(footer.buttons[index].props.disabled, true, `must be disabled while running: ${labels[index]}`);
  }
  // Cancelling is the only way out of a stuck job, so it must stay clickable.
  const cancel = footer.buttons.find((button) => textOf(button).includes("取消"));
  assert.ok(cancel, "a running job must offer 取消");
  assert.equal(cancel.props.disabled, false, "cancel must stay available while running");
});
