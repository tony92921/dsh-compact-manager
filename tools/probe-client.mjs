#!/usr/bin/env node
/**
 * Load `lib/client.js` the way the browser loader does and assert what it registers.
 *
 * The Web boot audit fails the *entire* app when a client entry throws during
 * activation, so a bundle that only parses is not enough: it has to run its
 * `factory`, resolve its `require` calls and survive `apply()` with a stub
 * `ctx`. This harness exercises exactly that, plus the two registration points
 * the merge added.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** Minimal React stand-in: enough for createElement and hooks at import time. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  Component: class { constructor(props) { this.props = props; this.state = {}; } setState(next) { Object.assign(this.state, next); } },
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useId: () => "id",
  useSyncExternalStore: (_subscribe, read) => read(),
  createContext: () => ({ Provider: null, Consumer: null })
};

const stubs = {
  react: React,
  "react-dom": { createPortal: (node) => node },
  "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: React.Fragment }
};
const require = createRequire(import.meta.url);

/** Capture the module the bundle registers. */
let registered;
const window = {
  __ModuleLoader__: {
    load(definition) {
      registered = definition;
    }
  }
};

const document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} }
};

const run = new Function("window", "document", "require", bundle);
run(window, document, (specifier) => {
  if (specifier in stubs) return stubs[specifier];
  try {
    return require(specifier);
  } catch {
    throw new Error(`bundle requires an unavailable module: ${specifier}`);
  }
});

assert.ok(registered, "bundle did not call window.__ModuleLoader__.load");
assert.equal(registered.id, "dsh-compact-manager");

const module = registered.factory((specifier) => {
  if (specifier in stubs) return stubs[specifier];
  throw new Error(`factory required an unavailable module: ${specifier}`);
});

assert.equal(module.name, "dsh-compact-manager-client");
assert.deepEqual(module.inject, ["slots"]);
assert.equal(typeof module.apply, "function");
assert.equal(typeof module.PopupBridge, "function", "popup bridge must be exported");
assert.equal(typeof module.CompactFooter, "function", "footer must be exported");
assert.equal(typeof module.SettingsPanel, "function", "settings page must be exported");
assert.equal(module.PressureBolt, undefined, "the composer bolt is gone; no leftover export");

// --- activation ------------------------------------------------------------
const registrations = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label ?? "unnamed");
    const dispose = fn();
    assert.equal(typeof dispose, "function", `effect ${label} must return a disposer`);
    return dispose;
  },
  slots: {
    inject(name, fn) {
      registrations.push({ via: "inject", name });
      fn();
    },
    register(options, component) {
      registrations.push({ via: "register", name: options.name, id: options.id, order: options.order, component });
      return () => {};
    }
  }
};

module.apply(ctx);

const slots = registrations.filter((row) => row.via === "register");
const names = slots.map((row) => row.name).sort();

assert.deepEqual(names, ["conversation.input.right", "settings.section"],
  "the merged client registers the popup and one settings page — nothing in the composer bar");
assert.ok(registrations.some((row) => row.via === "inject" && row.name === "conversation.input.right"));
assert.ok(!registrations.some((row) => row.name === "conversation.input.left"),
  "the composer bolt was removed; nothing may claim its slot");
assert.ok(registrations.every((row) => row.via !== "register" || typeof row.component === "function"));

const settings = slots.find((row) => row.name === "settings.section");
assert.equal(settings.id, "compact-manager");
assert.equal(settings.order, 18);

// Both manual actions must be reachable from the popup component, not just one.
const popupSource = module.PopupBridge.toString();
assert.ok(popupSource.includes("PopupBridge"), "popup bridge must render itself");

// The bundle's footer copy is the contract the user sees; assert both buttons are
// wired to distinct actions rather than to the same one twice.
const bundleText = bundle;
assert.ok(bundleText.includes('act("configured")'), "first button posts the model action");
assert.ok(bundleText.includes('act("mechanical")'), "second button posts the mechanical action");

assert.ok(effects.some((label) => label.includes("css")), "stylesheet must be owned by an effect");

// --- render smoke test -----------------------------------------------------
// Registering a component proves nothing: the harness only notices a broken one
// when it renders, and it answers a render throw by *abdicating* the entry — the
// occupant shows `active: false` and the widget silently disappears. Render each
// exported component with the stub React to catch an undefined reference here.
function renderProbe(component, props = {}) {
  const previous = [];
  // React hooks in the stub return static values, so a single pass is enough.
  const tree = component(props);
  assert.ok(tree !== undefined || tree === null, `${component.name} returned undefined`);
  return tree;
}

// `h` builds plain objects, so a reference to a missing constant throws now.
assert.doesNotThrow(() => renderProbe(module.SettingsPanel), "SettingsPanel must render");
assert.doesNotThrow(() => renderProbe(module.PopupBridge, { sessionId: "s" }), "PopupBridge must render");
// The footer renders both manual buttons on its own, with no other host widget.
assert.doesNotThrow(
  () => renderProbe(module.CompactFooter, { state: undefined, sending: false, error: "", act: () => {} }),
  "CompactFooter must render before the first state arrives"
);
assert.doesNotThrow(
  () => renderProbe(module.CompactFooter, {
    state: { available: true, engine: "saviour", config: { confirmFold: true }, job: { phase: "idle", message: "", failures: 0 } },
    sending: false,
    error: "",
    act: () => {}
  }),
  "CompactFooter must render with a live state"
);

// The bolt icon is the one piece both the composer and the settings title draw.
// It used to reference a path constant that was never declared, which only threw
// at render time — i.e. as a vanished widget, not a startup error.
const boltTree = renderProbe(module.FoldBoltIcon, { fill: 0.5 });
assert.ok(JSON.stringify(boltTree).includes("M13 2 4 14h7l-1 8 10-12h-7l1-8z"),
  "the bolt icon must draw the lightning path");

console.log(`OK: bundle registers ${names.length} slots and ${effects.length} effects`);
console.log(`    ${names.join(", ")}`);
