/**
 * The settings nav glyph.
 *
 * The settings nav paints its glyph from a table keyed by section id, and any id
 * it does not know gets the settings gear. A plugin cannot supply its own there:
 * the registration accepts an `icon` field but `navIcon(row.id)` never reads it.
 * That is why this plugin decorates the rendered row instead, and why these tests
 * exercise real node traversal rather than asserting that a builder produced a
 * string — the failure mode here is silent (a gear that looks intentional).
 *
 * The DOM below is a small hand-rolled stand-in: the host's nav rows plus the
 * handful of node methods the decorator touches. `MutationObserver` records its
 * target so a test can drive a re-render by hand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const NAV_ATTR = "data-dcm-nav-icon";
const STYLE_ID = "dsh-compact-manager/nav-icon.css";

/** One element: attributes, children, and the two queries the decorator uses. */
function element(text = "", { svg = true } = {}) {
  const node = {
    textContent: text,
    attributes: new Map(),
    children: svg ? [{ tag: "svg" }] : [],
    getAttribute: (name) => (node.attributes.has(name) ? node.attributes.get(name) : null),
    setAttribute: (name, value) => node.attributes.set(name, value),
    removeAttribute: (name) => node.attributes.delete(name),
    hasAttribute: (name) => node.attributes.has(name)
  };
  return node;
}

/**
 * Install a fake browser on `document`.
 *
 * `buttons` is replaced per test; `paint` re-runs what the observer would do so a
 * test can assert on decoration after the panel re-renders.
 */
function makeDocument(buttons) {
  const head = [];
  const observers = [];
  let callback = null;

  class FakeMutationObserver {
    constructor(fn) {
      callback = fn;
      observers.push(fn);
    }
    observe() {}
    disconnect() {
      observers.splice(observers.indexOf(callback), 1);
      callback = null;
    }
  }

  const document = {
    body: {},
    head: {
      appendChild: (node) => head.push(node),
      getElementById: (id) => head.find((node) => node.id === id) ?? null
    },
    createElement: () => {
      const node = {
        id: "",
        textContent: "",
        dataset: {},
        remove() {
          const at = head.indexOf(node);
          if (at >= 0) head.splice(at, 1);
        }
      };
      return node;
    },
    // The plugin's own stylesheet effect looks itself up by data-plugin-css; a
    // null answer means "create it", which is right for a cold start.
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '[role="dialog"] nav button') return buttons;
      if (selector === `[${NAV_ATTR}]`) return buttons.filter((b) => b.hasAttribute(NAV_ATTR));
      return [];
    },
    getElementById: (id) => head.find((node) => node.id === id) ?? null
  };

  return {
    document,
    MutationObserver: FakeMutationObserver,
    head,
    /** Fire the observer once, if one is live. */
    // The nav stylesheet, found by id.
    style: () => head.find((node) => node.id === STYLE_ID) ?? null,
    mutate() {
      if (callback !== null) callback([]);
    },
    observers
  };
}

/**
 * Load the bundle and return its exports.
 *
 * The module factory only builds the exports object; `apply` is what installs the
 * decorator, so it runs inside `ctx.effect` — the harness runs effects at once and
 * keeps the cleanup so a test can verify the plugin leaves no trace behind.
 */
function load({ buttons }) {
  const fake = makeDocument(buttons);
  const stubs = {
    react: {
      createElement: () => null,
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useMemo: (f) => f(),
      useCallback: (f) => f,
      Component: class Component {
        constructor(props) { this.props = props; this.state = {}; }
        setState() {}
      }
    },
    "react-dom": { createPortal: (node) => node },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: {} }
  };
  const require = createRequire(import.meta.url);
  let registered;
  new Function("window", "document", "require", "fetch", "MutationObserver", bundle)(
    { __ModuleLoader__: { load: (definition) => { registered = definition; } } },
    fake.document,
    (specifier) => {
      if (specifier in stubs) return stubs[specifier];
      return require(specifier);
    },
    () => Promise.reject(new Error("no network in this test")),
    fake.MutationObserver
  );

  const module = registered.factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unavailable module: ${specifier}`);
  });

  const cleanups = [];
  const ctx = {
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
      return cleanup;
    },
    slots: { inject: () => {}, register: () => {} }
  };
  module.apply(ctx);
  return { module, fake, cleanups };
}

test("the nav row labelled 压缩管理 is marked, and only that row", () => {
  const ours = element("压缩管理");
  const account = element("账户");
  const presets = element("Agent 预设");
  const { fake } = load({ buttons: [account, ours, presets] });

  assert.equal(ours.hasAttribute(NAV_ATTR), true);
  assert.equal(account.hasAttribute(NAV_ATTR), false);
  assert.equal(presets.hasAttribute(NAV_ATTR), false);
  assert.ok(fake.style(), "the nav stylesheet is installed");
});

/** The nav stylesheet node, found by id rather than by position. */
function navStyle(fake) {
  return fake.document.getElementById(STYLE_ID);
}

test("the stylesheet hides the host glyph and paints the mask instead", () => {
  const { fake } = load({ buttons: [element("压缩管理")] });
  const css = navStyle(fake).textContent;
  assert.ok(css.length > 0);

  // The host's own <svg> must go, or the gear would show beside the new mark.
  assert.match(css, /\[data-dcm-nav-icon\] > svg \{ display: none !important; \}/);
  // currentColor rather than a fixed token: the glyph then follows hover/active.
  assert.match(css, /background-color: currentColor/);
  assert.match(css, /mask: url\("data:image\/svg\+xml,/);
  // A mask needs opaque artwork; currentColor in the SVG would mask nothing.
  const art = decodeURIComponent(css.match(/svg\+xml,([^"]+)"/)[1]);
  assert.equal(/stroke="currentColor"/.test(art), false);
  assert.match(art, /stroke="#000"/);
});

test("the mask carries the official compact artwork, not a redrawn mark", () => {
  const { fake } = load({ buttons: [element("压缩管理")] });
  const css = navStyle(fake).textContent;
  const art = decodeURIComponent(css.match(/svg\+xml,([^"]+)"/)[1]);

  // The one path that makes this the official IconCompactOutline rather than
  // something merely circular: the 3/4 arc starting at the top.
  assert.match(art, /M8 1\.5C8\.85359 1\.5/);
  // And its faint backing ring.
  assert.match(art, /opacity="0\.35"/);
});

test("a re-render that drops the marker is repaired on the next mutation", async () => {
  const ours = element("压缩管理");
  const { fake } = load({ buttons: [ours] });

  // React replaced the row: a fresh node with no marker, same label.
  const replacement = element("压缩管理");
  fake.document.querySelectorAll = (selector) =>
    selector === '[role="dialog"] nav button' ? [replacement] : [];

  fake.mutate();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replacement.hasAttribute(NAV_ATTR), true);
});

test("a row relabelled away from ours loses the marker", async () => {
  const ours = element("压缩管理");
  const { fake } = load({ buttons: [ours] });
  assert.equal(ours.hasAttribute(NAV_ATTR), true);

  // Same node, but the host now renders a different section there.
  ours.textContent = "其他设置";
  fake.mutate();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ours.hasAttribute(NAV_ATTR), false);
});

test("unloading removes the stylesheet and every marker, restoring the gear", () => {
  const ours = element("压缩管理");
  const { fake, cleanups } = load({ buttons: [ours] });
  assert.equal(ours.hasAttribute(NAV_ATTR), true);
  assert.ok(fake.style(), "the nav stylesheet exists before unload");

  for (const cleanup of cleanups) cleanup();

  assert.equal(ours.hasAttribute(NAV_ATTR), false);
  assert.equal(fake.style(), null, "the nav stylesheet is removed again");
  assert.equal(fake.observers.length, 0, "the observer must be disconnected");
});
