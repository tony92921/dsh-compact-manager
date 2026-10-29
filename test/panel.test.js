/**
 * End-to-end render tests for the settings page.
 *
 * These exist because a unit test that calls a component directly cannot catch the
 * failure they cover: `TriggerPane` was written to receive `toggle` and `number` as
 * props, the call site was never updated to pass them, and every unit test still
 * passed because it supplied them by hand. In the browser the tab threw
 * `toggle is not a function` and React unmounted the pane.
 *
 * So the contract pinned here is the *wiring*, not the copy: mount the real
 * `SettingsPanel`, click every tab, and require that each one renders. A missing
 * prop, an undefined helper, or a component that throws now fails here instead of
 * in front of the user.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIZES } from "../lib/probe-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = readFileSync(join(root, "lib", "client.js"), "utf8");

/**
 * React stand-in with working state, effects and effects-with-cleanup.
 *
 * `useEffect` runs its callback immediately. The panel's effects fire fetches, so
 * `fetch` is stubbed globally below; without running them the component would
 * never leave its loading branch and every tab assertion would be vacuous.
 */
function makeReact() {
  const states = [];
  let cursor = 0;
  const refs = [];
  return {
    // Only the cursor moves: the stored values are the component state and must
    // survive a re-render, exactly as React keeps them. Clearing them would make
    // every render start from the initial values again.
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
      useEffect: (fn) => { try { const cleanup = fn(); return cleanup; } catch { /* effects are best-effort in the stub */ } },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useId: () => "id",
      useSyncExternalStore: (_subscribe, read) => read(),
      createContext: () => ({ Provider: null, Consumer: null })
    }
  };
}

/** Payloads the panel fetches on mount. */
const STATE = {
  config: {
    enabled: true,
    mode: "direct",
    provider: "p",
    model: "m",
    reasoningEffort: "low",
    thresholdOverride: true,
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    retainRatio: 0.16,
    ingress: true,
    snapImages: false,
    imagePixelBudget: 640000,
    minSnapTokens: 3000,
    savingsRatio: 0.85,
    confirmFold: true,
    replaceDefault: false,
    engine: "auto"
  },
  available: true,
  engine: "saviour",
  job: { phase: "idle", message: "", failures: 0 }
};

const HEALTH = {
  version: "1.0.0",
  sessionApi: "eventAt",
  ingress: { ok: true, shaped: 0, snapped: 0, savedTokens: 0, failures: 0, lastError: "" },
  shaping: { ok: true, shaped: 0, snapped: 0, savedTokens: 0, failures: 0, lastError: "" },
  compaction: {
    model: { compactions: 0, failures: 0, savedTokens: 0, lastBefore: 0, lastAfter: 0 },
    mechanical: { manual: 0, replaced: 0, live: 4 }
  },
  hook: { live: 4, wrapped: 0, mechanicalFolds: 0, replacedFolds: 0, unsupported: 0, unsupportedEngines: [] },
  config: {}
};

const THRESHOLD = {
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

/**
 * Per-test replacement for the state payload.
 *
 * The model tab's hints depend on `enabled` × `mode`, and the bug this file now
 * pins was a hint that described `mode` while the switch was off. Testing that
 * needs both sides of the matrix, so the stub reads an override instead of the
 * frozen `STATE`.
 */
let stateOverride = null;

/**
 * When set, the next settings POST fails with this message.
 *
 * The Host refuses genuinely invalid input (a half-chosen model pair, an unsupported
 * reasoning level), and autosave has to surface that refusal. Reading the body is not
 * enough: the test needs the POST to come back as a rejection.
 */
let settingsRejection = null;
function rejectNextSettings(message) { settingsRejection = message; }

/**
 * Requests the panel made, so autosave can be observed from the outside.
 *
 * Every entry is `{ url, body }`; `body` is the parsed POST payload, which is what
 * the Host would store. Without this the only evidence of a save would be a DOM
 * message, and a test that trusted the message could pass while nothing was sent.
 */
const requests = [];

/** Resolve the stubbed fetch by URL shape. */
function stubFetch() {
  return async (url, init) => {
    const target = String(url);
    requests.push({
      url: target,
      body: init?.body ? JSON.parse(init.body) : undefined
    });
    let body = stateOverride ?? STATE;
    if (target.includes("models=1")) body = {
      models: [{ provider: "p", model: "m", name: "M", id: "m" }],
      // The host ships the probe sizes with the model list so the picker cannot
      // drift from what the host will actually send. The stub carries the real
      // list for the same reason.
      sizes: SIZES.map(({ id, label }) => ({ id, label }))
    };
    else if (target.includes("health=1")) body = HEALTH;
    else if (target.includes("threshold=1")) body = THRESHOLD;
    else if (target.includes("provider=")) body = { efforts: [{ id: "low" }], contextWindow: 1_000_000 };
    if (settingsRejection && init?.body && JSON.parse(init.body).action === "settings") {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: settingsRejection }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function loadPanel() {
  const harness = makeReact();
  const stubs = {
    react: harness.React,
    "react-dom": { createPortal: (node) => node },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: harness.React.Fragment }
  };
  const require = createRequire(import.meta.url);
  let registered;
  const run = new Function("window", "document", "require", "fetch", bundle);
  run({
    __ModuleLoader__: { load: (definition) => { registered = definition; } }
  }, {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} }
  }, (specifier) => {
    if (specifier in stubs) return stubs[specifier];
    return require(specifier);
  }, stubFetch());
  return { module: registered.factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unavailable module: ${specifier}`);
  }), harness };
}

/**
 * Expand components the way React would.
 *
 * `h(...)` returns a plain object whose `type` is the component function, so
 * nothing renders until it is invoked. Throwing here is the point: a component
 * that references an undefined helper throws at render time, exactly as it does in
 * the browser.
 */
function expand(node, depth = 0) {
  assert.ok(depth < 60, "render expanded too deep; a component is probably looping");
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  const children = Array.isArray(node.children) ? node.children.map((child) => expand(child, depth)) : node.children;
  if (typeof node.type === "function") {
    return expand({ ...node, children, ...node.type({ ...node.props, children }) }, depth + 1);
  }
  return { ...node, children };
}

/** Every element of a given type in a rendered tree. */
function findAll(node, type) {
  const found = [];
  const walk = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) { current.forEach(walk); return; }
    if (current.type === type) found.push(current);
    if (Array.isArray(current.children)) current.children.forEach(walk);
  };
  walk(node);
  return found;
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  const own = Array.isArray(node.children) ? node.children.map(textOf).join("") : "";
  const props = node.props ?? {};
  const fromProps = ["title", "aria-label"].map((key) => props[key]).filter((v) => typeof v === "string").join(" ");
  return own + " " + fromProps;
}

/**
 * Mount the panel and drive it like React would.
 *
 * The stub's `useState` setter stores the value but cannot schedule a re-render,
 * and the panel's data arrives from an async fetch. So mounting is a two-phase
 * thing: render once to let the effects fire, let the pending promises settle, then
 * render again to observe the loaded state. Every later interaction re-renders the
 * same way.
 */
function mountPanel() {
  const { module, harness } = loadPanel();
  assert.equal(typeof module.SettingsPanel, "function");
  const render = () => {
    harness.reset();
    return expand(module.SettingsPanel({}));
  };
  let tree = render();
  return {
    /** Re-render after awaited state changes have landed. */
    settle() {
      tree = render();
      return tree;
    },
    get tree() { return tree; },
    get text() { return textOf(tree); },
    get tabs() {
      return findAll(tree, "button").filter((button) => button.props?.role === "tab");
    },
    /** Click the tab whose label contains `label`, then re-render. */
    openTab(label) {
      const tab = this.tabs.find((button) => textOf(button).includes(label));
      assert.ok(tab, `no tab matching "${label}"; have ${this.tabs.map((button) => textOf(button).trim()).join(", ")}`);
      tab.props.onClick();
      tree = render();
      return tree;
    },
    /**
     * Flip a checkbox by its label text, then re-render.
     *
     * The label and its control share a row, so the checkbox is located from the row
     * that contains the text rather than from a guessed index.
     */
    toggleByLabel(label) {
      const row = findAll(tree, "div").find((node) =>
        textOf(node).includes(label) && findAll(node, "input").length === 1);
      assert.ok(row, `no row with a single control matching "${label}"`);
      const checkbox = findAll(row, "input")[0];
      checkbox.props.onChange({ target: { checked: !checkbox.props.checked } });
      tree = render();
      return checkbox.props.checked;
    }
  };
}

/**
 * Mount and wait for the initial fetches.
 *
 * `setImmediate` after the render gives the stubbed `fetch` promises a turn to
 * resolve and the effects' `setState` calls a chance to land in the stub's state
 * slots; the second render then reads them.
 */
async function mountLoaded({ settlePreview = false } = {}) {
  const panel = mountPanel();
  // Two turns: the effects await `Promise.all`, which awaits the fetch promises.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  panel.settle();
  if (settlePreview) {
    // The threshold preview is debounced by 250ms in an effect, so it needs both
    // the timer to fire and the request to resolve before it can be asserted on.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    panel.settle();
  }
  return panel;
}

test("the panel mounts past its loading branch", async () => {
  const panel = await mountLoaded();
  assert.doesNotMatch(panel.text, /正在读取设置/, "a resolved fetch must leave the loading state");
});

// --- autosave ---------------------------------------------------------------
//
// There is no Save button any more, so these tests are the only thing that keeps an
// edit from looking applied while it was never written. They assert on what actually
// crossed the wire (`requests`), not on the status line: a message that says "已自动
// 保存" proves nothing about the Host's stored config.

/**
 * Wait past the 250ms debounce, let the request resolve, and re-render.
 *
 * The stub's `useState` setter cannot schedule a render, so a test that asserts on
 * the status line must re-render by hand after the write lands.
 */
async function settleSave(panel) {
  await new Promise((resolve) => setTimeout(resolve, 320));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  panel?.settle();
}

/** The settings POSTs recorded so far. */
const settingsPosts = () => requests.filter((entry) => entry.body?.action === "settings");

test("the settings page has no Save button at all", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  for (const label of ["模型", "触发线", "入境", "折页"]) {
    panel.openTab(label);
    const buttons = findAll(panel.tree, "button").map((button) => textOf(button));
    assert.ok(!buttons.some((text) => /^保存$|保存中/.test(text.trim())),
      `tab ${label} still offers a Save button: ${buttons.join(" | ")}`);
  }
});

test("flipping a toggle writes the setting without pressing anything", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("入境");
  requests.length = 0;
  panel.toggleByLabel("允许密图");
  await settleSave(panel);
  const posts = settingsPosts();
  assert.equal(posts.length, 1, `expected exactly one settings write, got ${posts.length}`);
  assert.equal(posts[0].body.config.snapImages, true, "the new value must be what was sent");
  // The whole config travels, not just the changed key: the Host replaces the record.
  assert.equal(posts[0].body.config.ingress, true, "unchanged fields must survive the write");
});

test("a burst of edits is coalesced into one request", async () => {
  // Dragging a number field fires an onChange per keystroke. One request per event
  // would hammer the Host, which resolves model metadata on every save.
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("入境");
  requests.length = 0;
  for (let i = 0; i < 5; i += 1) panel.toggleByLabel("允许密图");
  await settleSave(panel);
  assert.equal(settingsPosts().length, 1, "five quick toggles must cost one write, not five");
});

test("an edit made during a save is not reverted by that save's response", async () => {
  // The race a Save button never had to face: the Host echoes the config it stored,
  // and adopting that echo after a newer edit would silently undo the edit.
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("入境");
  requests.length = 0;
  panel.toggleByLabel("允许密图");
  // Fire the first save, then edit again before its response is applied.
  await new Promise((resolve) => setTimeout(resolve, 260));
  panel.toggleByLabel("允许密图");
  await settleSave(panel);
  const posts = settingsPosts();
  assert.ok(posts.length >= 2, `the second edit must reach the Host too; got ${posts.length} write(s)`);
  assert.equal(posts[posts.length - 1].body.config.snapImages, false,
    "the last write must carry the last edit, not the value the earlier save echoed back");
});

test("the status line does not claim success while a write is still pending", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("入境");
  panel.toggleByLabel("允许密图");
  // Before the debounce fires, the panel must not say "已自动保存".
  assert.doesNotMatch(panel.text, /已自动保存/, "an unsent edit must not be reported as saved");
  await settleSave(panel);
  assert.match(panel.text, /已自动保存/, "a landed write must be acknowledged");
});

test("a rejected write is shown as an error, not as a saved value", async () => {
  // With no Save button the controls already display the new value, so a rejection
  // that rendered identically to success would be invisible — the user would believe
  // a refused config was stored.
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("入境");
  rejectNextSettings("请选择完整的压缩模型。");
  try {
    panel.toggleByLabel("允许密图");
    await settleSave(panel);
    assert.match(panel.text, /未保存/, "a rejection must be labelled as not saved");
    assert.match(panel.text, /请选择完整的压缩模型/,
      "the Host's reason must reach the user instead of a generic failure");
    assert.doesNotMatch(panel.text, /已自动保存/, "a failed write must not also claim success");
    // Pick the innermost node carrying the text: the root div contains it too, and
    // asserting on the root would test nothing.
    const note = findAll(panel.tree, "div")
      .filter((node) => textOf(node).includes("未保存"))
      .pop();
    assert.ok(note, "the error must be rendered");
    assert.equal(note.props["data-error"], true, "the note must use the error styling");
  } finally {
    rejectNextSettings(null);
  }
});

test("every tab renders without throwing", async () => {
  const panel = await mountLoaded();
  const labels = ["模型", "触发线", "入境", "折页", "诊断"];
  for (const label of labels) {
    assert.doesNotThrow(() => panel.openTab(label), `tab "${label}" must render`);
  }
});

test("the trigger tab shows the resolved trigger from the Host", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("触发线");
  assert.match(panel.text, /800k/, "the trigger token count must be on screen");
  assert.match(panel.text, /80\.0%/);
  assert.match(panel.text, /保留原文/);
});

test("the trigger tab exposes all four editable fields", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("触发线");
  const text = panel.text;
  // The labels are the contract: each row renders a <label> with this text, and the
  // control beside it is either a checkbox (the override switch) or a number input.
  for (const label of ["接管自动压缩阈值", "触发线比例", "预留空间 headroom", "保留原文 retain"]) {
    assert.ok(text.includes(label), `the {label} row must be rendered; got: ${text.slice(0, 200)}`);
  }
  const inputs = findAll(panel.tree, "input");
  const checkboxes = inputs.filter((input) => input.props?.type === "checkbox");
  assert.equal(checkboxes.length, 1, "exactly one switch on this pane");
  assert.equal(checkboxes[0].props.checked, true, "the override defaults to on");
});

test("the diagnostics tab shows both strategy groups", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("诊断");
  // The health fetch runs from the refresh button, so click it before asserting.
  const refresh = findAll(panel.tree, "button").find((button) => textOf(button).includes("刷新"));
  assert.ok(refresh, "the diagnostics tab must offer a refresh action");
  refresh.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  panel.settle();
  assert.match(panel.text, /模型压缩/);
  assert.match(panel.text, /非模型压缩/);
  assert.match(panel.text, /手动折页/);
});

test("the model tab offers both models, not just one", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("模型");
  // Two pickers must exist: the primary summarizer and the optional fallback. Both
  // are labelled "备用模型 N" because they back up the official summarizer — a lone
  // "选择模型" row gives no hint that a second one can be configured.
  //
  // There is no search box: it used to be a separate row labelled "备用模型 1 · 主压缩
  // 模型" whose only control was a filter input, so the row that named the setting did
  // not hold its value, and it filtered *both* pickers from one shared string.
  assert.match(panel.text, /备用模型 1/);
  assert.match(panel.text, /备用模型 2/);
  assert.doesNotMatch(panel.text, /搜索已配置的模型/, "the model pickers are not filtered");
  const selects = findAll(panel.tree, "select").map((select) => select.props["aria-label"]).filter(Boolean);
  assert.ok(selects.includes("压缩模型"), `model 1 picker missing; have ${selects.join(", ")}`);
  assert.ok(selects.includes("备用压缩模型"), `fallback picker missing; have ${selects.join(", ")}`);
});

test("every model picker row carries its own selection control", async () => {
  // A row whose label names a setting must hold that setting's control. The dropped
  // search row named "备用模型 1 · 主压缩模型" but held only a text filter, which made
  // it read as a duplicate of the picker below it.
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("模型");
  const inputs = findAll(panel.tree, "input")
    .filter((input) => input.props?.type === "text")
    .map((input) => input.props?.placeholder)
    .filter(Boolean);
  assert.deepEqual(inputs, [], "the model tab must not carry free-text inputs for model selection");
});

test("the fallback picker states that leaving it empty disables the fallback", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("模型");
  assert.match(panel.text, /不启用备用模型/, "the empty option must say what it means");
});

test("the model tab offers a test button per model, plus a length picker", async () => {
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("模型");
  const buttons = findAll(panel.tree, "button").map((button) => textOf(button));
  assert.ok(buttons.some((text) => text.includes("测试模型 1")), `model 1 probe button missing; have ${buttons.join(" | ")}`);
  assert.ok(buttons.some((text) => text.includes("测试模型 2")), "model 2 probe button missing");
  assert.ok(panel.text.includes("测试长度"), "the length picker must be labelled");
  assert.match(panel.text, /会花掉可观的 token/,
    "the probe spends real tokens, and the button must say so before it is pressed");
  // The picker must offer every host-side size, including the 1M option that exists
  // to prove a full history can be compacted at all. Assert against the host list
  // rather than hardcoded strings, so adding a size cannot pass unnoticed.
  for (const size of SIZES) {
    assert.ok(panel.text.includes(size.label), `length picker is missing ${size.id} (${size.label})`);
  }
});

test("both probe buttons exist even when model 2 is unconfigured", async () => {
  // Hiding the second button when no fallback is set would make the fallback look
  // untestable; it should be present and explain that it has nothing to test.
  const panel = await mountLoaded({ settlePreview: true });
  panel.openTab("模型");
  const buttons = findAll(panel.tree, "button").map((button) => ({
    text: textOf(button),
    disabled: button.props?.disabled
  }));
  const second = buttons.find((button) => button.text.includes("测试模型 2"));
  assert.ok(second, "the model 2 button must render regardless of configuration");
  assert.match(second.text, /未配置/, "it must say there is nothing configured to test");
});

/** Mount the model tab with a specific `enabled` × `mode` pair from the host. */
async function mountSwitch(enabled, mode) {
  stateOverride = { ...STATE, config: { ...STATE.config, enabled, mode } };
  try {
    const panel = await mountLoaded({ settlePreview: true });
    panel.openTab("模型");
    return panel;
  } finally {
    stateOverride = null;
  }
}

test("with the helper off, neither control claims to hand compression to a model", async () => {
  // This was a real bug: the switch's own hint branched on `mode` and never checked
  // `enabled`, so "off + direct" rendered two rows contradicting each other — one
  // saying the model handles automatic compaction, the other saying the official one
  // does. With the switch off `mode` is never read, so both rows must say so.
  //
  // The forbidden pattern is "交给下方" rather than one exact sentence: the point is
  // the *claim* of delegation, and pinning a full sentence would let a paraphrase of
  // the same wrong claim pass.
  for (const mode of ["rescue", "direct"]) {
    const panel = await mountSwitch(false, mode);
    assert.doesNotMatch(panel.text, /交给下方/,
      `off + ${mode}: no row may delegate automatic compaction to a model while the helper is off`);
    assert.match(panel.text, /此项不生效/, `off + ${mode}: the select must state that it is inactive`);
    assert.match(panel.text, /自动压缩完全由官方/, `off + ${mode}: the switch must say who handles it`);
  }
});

test("the action select is disabled while the helper is off", async () => {
  const panel = await mountSwitch(false, "rescue");
  const selects = findAll(panel.tree, "select").filter((select) =>
    findAll(select, "option").some((option) => textOf(option).includes("官方优先")));
  assert.equal(selects.length, 1, "the action select must be identifiable");
  assert.equal(selects[0].props.disabled, true,
    "a control whose value is unread must not look editable");
});

test("with the helper on, each mode describes its own behaviour", async () => {
  const direct = await mountSwitch(true, "direct");
  assert.match(direct.text, /自动压缩直接交给下方备用模型/);
  assert.match(direct.text, /官方摘要器不参与/);
  assert.doesNotMatch(direct.text, /救援前官方失败次数/, "the rescue count is meaningless in direct mode");

  const rescue = await mountSwitch(true, "rescue");
  assert.match(rescue.text, /自动压缩先由官方处理/);
  assert.match(rescue.text, /救援前官方失败次数/, "rescue mode must expose the failure threshold");
});

test("non-model compaction is available on the model tab, under the two switches", async () => {
  // It used to sit at the bottom of the tab after the live probe, which read as a
  // probe option. It is an automatic-path override, so it belongs with the others —
  // below `压缩方式` (and its rescue count) but above the connectivity probe.
  const panel = await mountSwitch(true, "rescue");
  const text = panel.text;
  const helper = text.indexOf("启用自动压缩辅助");
  const mode = text.indexOf("压缩方式");
  const rescueCount = text.indexOf("救援前官方失败次数");
  const fold = text.indexOf("使能非模型压缩");
  const probe = text.indexOf("连通性测试");
  assert.ok([helper, mode, rescueCount, fold, probe].every((at) => at !== -1), "all five rows must render");
  assert.ok(mode > helper, "the mode select follows the switch it depends on");
  assert.ok(rescueCount > mode, "the rescue count follows the mode select it belongs to");
  assert.ok(fold > rescueCount, "non-model compaction follows the mode group");
  assert.ok(fold < probe, "non-model compaction must not sit past the connectivity probe");
});
