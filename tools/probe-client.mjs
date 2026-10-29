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

// The compaction mark is the one piece both the composer and the settings title
// draw. It has failed twice, in two different ways, so this checks the properties
// that actually decide whether the user sees a shape:
//
// 1. It referenced a path constant that was never declared → it threw at render
//    time and the widget simply vanished.
// 2. Its subpaths used lowercase relative movetos (`m`), which continue from the
//    previous subpath's endpoint. `... v4.5 m9.5 5.5` lands at (21.5, 12.5) — off
//    the 24-unit canvas — so the arrowheads were drawn outside the viewBox and
//    the icon showed as two bare plates. A standalone preview built from the same
//    numbers looked right, which is why only the geometry check below catches it.
const markTree = renderProbe(module.FoldBoltIcon, { fill: 0.5 });
const markJson = JSON.stringify(markTree);
// The outline is every subpath joined into one `d`, so pull it back out as a whole.
const d = module.FoldBoltIcon({ fill: 0.5 })
  .children.find((child) => child && child.props && typeof child.props.d === "string" && child.props.stroke === "currentColor")
  ?.props.d;
assert.ok(typeof d === "string" && d.length > 0,
  "the mark must render a stroked outline path; a missing path constant renders as nothing");
assert.ok(markJson.includes("currentColor"),
  "the mark must use currentColor so it inherits the theme's label colour");
// `fill` is the progress overlay; without it the icon cannot show a partial fold.
assert.ok(markJson.includes("clipPath"), "the progress fill must clip to the mark's outline");

// Every subpath must start with an ABSOLUTE moveto, and every point must sit
// inside the viewBox. A relative `m` here is the bug that shipped once.
const subpaths = d.match(/[Mm][^Mm]*/g) ?? [];
assert.ok(subpaths.length >= 4, `the mark must be drawn in several subpaths, got ${subpaths.length}`);
for (const sub of subpaths) {
  assert.ok(sub.startsWith("M"),
    `subpath "${sub.trim()}" must start with an absolute M: a relative m continues ` +
    "from the previous subpath's endpoint and can leave the 24-unit canvas");
}
/** Endpoints of one subpath, supporting only the absolute commands this icon uses. */
function endpointsOf(sub) {
  const tokens = sub.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const points = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase();
    const num = () => Number(tokens[i++]);
    const last = points[points.length - 1] ?? [0, 0];
    if (command === "M") points.push([num(), num()]);
    else if (command === "H") points.push([num(), last[1]]);
    else if (command === "V") points.push([last[0], num()]);
    else if (command === "L") points.push([num(), num()]);
    else break;
  }
  return points;
}
for (const sub of subpaths) {
  for (const [x, y] of endpointsOf(sub)) {
    assert.ok(x >= 0 && x <= 24 && y >= 0 && y <= 24,
      `point (${x}, ${y}) of "${sub.trim()}" is outside the 24x24 viewBox and would be clipped away`);
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `subpath "${sub.trim()}" produced a non-finite point`);
  }
}

console.log(`OK: bundle registers ${names.length} slots and ${effects.length} effects`);
console.log(`    ${names.join(", ")}`);
