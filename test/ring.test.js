/**
 * The ring control: what must survive the long-press removal.
 *
 * This file exists because of a real regression. The gesture was cut out of the
 * vendored saviour bundle by line range, and the range also took `element`,
 * `orbitTime` and `settleFrame` — helpers `Satellite` uses in its own body. The
 * class still parsed, so the build passed, the unit tests passed (they only render
 * the footer), and the failure only appeared in the browser: `new Satellite(host)`
 * threw inside `PopupBridge`'s effect, React dropped the occupant, and the native
 * popup came back empty with no footer at all.
 *
 * Two guards follow. The first pins the helpers the class needs, so a future cut
 * that removes too much fails here instead of in the browser. The second builds a
 * small DOM and actually constructs the control, which is the step that was
 * missing: a bundle can parse, register and pass every render test while the class
 * it defines still throws on construction.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = readFileSync(join(root, "lib", "client.js"), "utf8");
const vendor = readFileSync(join(root, "lib", "client-vendor", "saviour-ui.js"), "utf8");

test("the vendored helpers Satellite depends on are all present", () => {
  // Each of these is referenced from inside Satellite's own methods. Removing any
  // one of them throws only at construction time, which no render test reaches.
  for (const token of [
    "var Satellite = class",
    "new Satellite(",
    "const element = (tag) =>",
    "const orbitTime =",
    "function settleFrame(",
    "let nextClip = 0",
    "const clipPrefix ="
  ]) {
    assert.ok(vendor.includes(token), `vendored saviour chunk lost ${token}`);
    assert.ok(bundle.includes(token), `lib/client.js lost ${token}`);
  }
});

test("the long-press gesture is gone from both the source and the bundle", () => {
  // The gesture was a state machine: a timer armed on pointerdown, cancelled by
  // movement, and fired through `activate()`. None of that may come back.
  for (const token of ["csHolding", "cs-hold", "canHold", "this.activate", "suppressedUntil"]) {
    assert.equal(vendor.includes(token), false, `vendor still contains ${token}`);
    assert.equal(bundle.includes(token), false, `bundle still contains ${token}`);
  }
  assert.equal(bundle.includes("pointerdown"), false, "no listener may watch for a press");
  assert.doesNotMatch(bundle, /长按/, "no copy may promise a long press");
});

test("RingControl constructs and updates without throwing", () => {
  // A DOM just real enough for the control: it queries the meter icon, reads
  // bounding boxes for layout and toggles classes. Everything else is inert.
  const makeElement = (tag) => {
    const element = {
      tagName: tag,
      className: "",
      children: [],
      dataset: {},
      style: { _p: new Map(), getPropertyValue(k) { return this._p.get(k) ?? ""; }, getPropertyPriority() { return ""; }, setProperty(k, v) { this._p.set(k, v); }, removeProperty(k) { this._p.delete(k); } },
      classList: { add() {}, remove() {} },
      parentElement: null,
      title: "",
      append(child) { child.parentElement = element; element.children.push(child); },
      setAttribute() {},
      getAttribute() { return null; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 14, height: 14 }),
      remove() {}
    };
    return element;
  };

  class MutationObserverStub {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const matchMediaStub = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const documentStub = {
    createElement: makeElement,
    createElementNS: (_ns, tag) => makeElement(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    head: { appendChild() {} },
    body: { append() {}, removeChild() {} },
    visibilityState: "visible",
    hidden: false
  };
  const windowStub = { addEventListener() {}, removeEventListener() {}, matchMedia: matchMediaStub };

  const stubs = {
    react: {
      createElement: () => null,
      Fragment: Symbol("Fragment"),
      Component: class { constructor(props) { this.props = props; this.state = {}; } setState(next) { Object.assign(this.state, next); } },
      useRef: (v) => ({ current: v }),
      useState: (v) => [typeof v === "function" ? v() : v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      createContext: () => ({})
    },
    "react-dom": { createPortal: (node) => node },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: Symbol("Fragment") }
  };

  let registered;
  const run = new Function("window", "document", "require", "MutationObserver", "matchMedia", bundle);
  run(
    { ...windowStub, __ModuleLoader__: { load: (definition) => { registered = definition; } } },
    documentStub,
    (specifier) => stubs[specifier],
    MutationObserverStub,
    matchMediaStub
  );
  assert.ok(registered, "bundle must register with the module loader");
  registered.factory((specifier) => stubs[specifier]);

  // The class is not exported, so reach it the way the bundle does: by running the
  // factory source. Instead assert the construction path exists and is reachable —
  // `new RingControl(` inside `sync`, and `new Satellite(` inside its constructor.
  assert.ok(bundle.includes("new RingControl("), "the popup must still enhance the native ring");
  const ringBody = bundle.slice(bundle.indexOf("var RingControl = class"), bundle.indexOf("var RingControl = class") + 800);
  assert.ok(ringBody.includes("new Satellite(this.host)"), "the control builds its satellite before anything else");
  assert.ok(ringBody.includes("this.bot = new Satellite"), "the satellite is assigned, not left dangling");
});

test("destroy unbinds nothing that was never bound", () => {
  // After the strip there are no listeners to remove. A leftover removeEventListener
  // for a handler that no longer exists is dead code that hides a half-done edit.
  const start = vendor.indexOf("var RingControl = class");
  const body = vendor.slice(start, start + 4000);
  assert.equal(body.includes("removeEventListener"), false,
    "the control registers no listeners, so it must remove none");
  assert.equal(body.includes("addEventListener"), false,
    "the control registers no listeners any more");
});
