/**
 * Tests for the strategy decision and the settings normalizer.
 *
 * `chooseFor` is the whole point: two settings sets each say something about
 * "who compacts this time", and one function has to honour both without silently
 * changing what either says. Every row of the table in `lib/controller.js` is
 * asserted here, including the interactions the two sets create when combined.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../lib/controller.js";
import { DEFAULTS, ENGINES, settingsSchema, Config, FIELDS, VERSION, PACKAGE, SERVICE } from "../lib/config.js";
import { flattenObjectEnvelope } from "../lib/ledger/schema-envelope.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** The strategy function under test, without constructing a Controller. */
const chooseFor = (config, explicit) => Controller.prototype.chooseFor.call(null, config, explicit);

const base = () => ({ ...DEFAULTS });

test("auto folds only when no saviour model is configured", () => {
  assert.equal(chooseFor({ ...base(), provider: "", model: "" }), "ledger");
  assert.equal(chooseFor({ ...base(), provider: "p", model: "m" }), "saviour");
  // A half-configured model is not a model: it would fail at request time, so the
  // safe reading is "nothing to compact with" rather than "try and throw".
  assert.equal(chooseFor({ ...base(), provider: "p", model: "" }), "ledger");
  assert.equal(chooseFor({ ...base(), provider: "", model: "m" }), "ledger");
});

test("an explicit engine setting beats auto", () => {
  assert.equal(chooseFor({ ...base(), engine: "ledger", provider: "p", model: "m" }), "ledger");
  assert.equal(chooseFor({ ...base(), engine: "saviour", provider: "", model: "" }), "saviour");
});

test("replaceDefault is the hard override for every manual path", () => {
  // The promise of the switch is "no automatic or manual compaction calls a
  // model", so it has to win over a configured model and over engine=saviour.
  assert.equal(chooseFor({ ...base(), replaceDefault: true, engine: "saviour", provider: "p", model: "m" }), "ledger");
  assert.equal(chooseFor({ ...base(), replaceDefault: true, engine: "auto", provider: "p", model: "m" }), "ledger");
});

test("a command-line engine beats the stored setting and replaceDefault", () => {
  // `/fast-compact saviour` is an explicit, one-run request; honouring it is what
  // makes the command a way out of a stuck configuration.
  assert.equal(chooseFor({ ...base(), replaceDefault: true, engine: "ledger" }, "saviour"), "saviour");
  assert.equal(chooseFor({ ...base(), engine: "saviour" }, "ledger"), "ledger");
  assert.equal(chooseFor({ ...base(), engine: "ledger" }, "auto"), "ledger", "auto still resolves normally");
});

test("the merged defaults keep both halves' previous behaviour", () => {
  const config = base();
  // saviour: rescue mode, on, no model yet — the plugin is installed but idle.
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "rescue");
  assert.equal(config.provider, "");
  // ledger: ingress on, images off, fold confirmation on, no default replacement.
  assert.equal(config.ingress, true);
  assert.equal(config.snapImages, false);
  assert.equal(config.confirmFold, true);
  assert.equal(config.replaceDefault, false);
  assert.equal(config.engine, "auto");
  // trigger: override on, but the three values reproduce compaction-basic's own
  // defaults exactly — an untouched install must behave identically.
  assert.equal(config.thresholdOverride, true);
  assert.equal(config.thresholdRatio, 0.8);
  assert.equal(config.headroomTokens, 65536);
  assert.equal(config.retainRatio, 0.16);
});

test("settings normalizer clamps and defaults every merged field", () => {
  const normalized = settingsSchema({});
  assert.deepEqual(normalized, base());

  // Out-of-range numbers clamp instead of resetting.
  assert.equal(settingsSchema({ minSnapTokens: 5 }).minSnapTokens, 200);
  assert.equal(settingsSchema({ minSnapTokens: 9e9 }).minSnapTokens, 200000);
  assert.equal(settingsSchema({ imagePixelBudget: 1 }).imagePixelBudget, 200000);
  assert.equal(settingsSchema({ savingsRatio: 0 }).savingsRatio, 0.05);
  assert.equal(settingsSchema({ savingsRatio: 9 }).savingsRatio, 1);

  // Unknown enum members fall back rather than leaking through.
  assert.equal(settingsSchema({ engine: "nope" }).engine, "auto");
  assert.equal(settingsSchema({ mode: "nope" }).mode, "rescue");
  assert.equal(settingsSchema({ engine: "ledger" }).engine, "ledger");
  assert.equal(settingsSchema({ mode: "direct" }).mode, "direct");

  // Non-booleans are not truthy-coerced: a stored "false" string is not false.
  assert.equal(settingsSchema({ ingress: "false" }).ingress, true);
  assert.equal(settingsSchema({ ingress: false }).ingress, false);

  // The trigger bounds are tighter than the plugin's other ratios: a 100% trigger
  // can never fire before the window overflows, and a 0% one fires on the first
  // message when there is nothing to compact.
  assert.equal(settingsSchema({ thresholdRatio: 0 }).thresholdRatio, 0.1);
  assert.equal(settingsSchema({ thresholdRatio: 5 }).thresholdRatio, 0.95);
  assert.equal(settingsSchema({ retainRatio: 0 }).retainRatio, 0.02);
  assert.equal(settingsSchema({ retainRatio: 5 }).retainRatio, 0.5);
  assert.equal(settingsSchema({ headroomTokens: -1 }).headroomTokens, 0);
  assert.equal(settingsSchema({ headroomTokens: 9e9 }).headroomTokens, 400000);
});

test("the persisted schema and the normalizer agree on every field", () => {
  const normalized = settingsSchema({});
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(FIELDS).sort());
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(DEFAULTS).sort());
  // A Config instance must expose every key with the same default the normalizer
  // uses; a field added to one and not the other would silently never save.
  const live = Config({});
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in live, `Config is missing ${key}`);
    assert.equal(live[key].get(), DEFAULTS[key], `Config default for ${key}`);
  }
});

test("every Config field is volatile so the page can write it", () => {
  const live = Config({});
  for (const key of Object.keys(DEFAULTS)) {
    const symbols = Object.getOwnPropertySymbols(live[key]);
    assert.ok(
      symbols.some((symbol) => String(symbol).includes("volatile")),
      `${key} is not volatile; settings.update() would refuse the write`
    );
  }
});

test("the wire envelope round-trips the merged field table", () => {
  const envelope = settingsSchema.toJSON();
  const fields = flattenObjectEnvelope(envelope);
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(DEFAULTS).sort());
});

test("version and package identity match the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, PACKAGE);
  assert.equal(manifest.version, VERSION);
  assert.equal(SERVICE, "compactManager");
  assert.ok(manifest.dsh.client, "a client half must be declared or the bundle is never discovered");
  assert.ok(manifest.exports["./client"], "the declared client path must be exported");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
});

test("ENGINES matches the union the command accepts", () => {
  assert.deepEqual(ENGINES, ["auto", "ledger", "saviour"]);
});
