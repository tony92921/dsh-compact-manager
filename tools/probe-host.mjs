#!/usr/bin/env node
/**
 * Load the Host half the way Cordis does and assert what it provides.
 *
 * The Host entry is imported by the Loader and its `apply(ctx, config)` runs with
 * a resolved Config instance. A throw there fails the plugin's fiber, which the
 * desktop shows as a plugin that will not start. This harness stands in the small
 * part of `ctx` this plugin touches and proves:
 *
 *   - the module loads and exports the expected shape
 *   - `apply` registers the command, the HTTP route and the remote service
 *   - the settings facade round-trips a full object into the Config schema
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const lib = pathToFileURL(join(here, "..", "lib", "index.js")).href;

const module = await import(lib);

assert.equal(module.name, "dsh-compact-manager");
assert.equal(typeof module.apply, "function");
assert.equal(typeof module.Config, "function");
assert.ok(Array.isArray(module.inject), "inject must be a service list");

const { Config } = module;
const config = Config({});

// --- stub context ----------------------------------------------------------
const listeners = [];
const effects = [];
const provided = new Map();
const commands = [];
const routes = [];
const typert = [];
let settingsWrites = [];
let configured;

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn, label) {
    effects.push(label ?? "unnamed");
    const dispose = fn();
    assert.equal(typeof dispose, "function", `effect ${label} must return a disposer`);
    return dispose;
  },
  on(event, handler, options) {
    listeners.push({ event, options });
    return () => {};
  },
  get(name) {
    return undefined;
  },
  provide(name, value) {
    provided.set(name, value);
    return () => {};
  },
  commands: {
    register(definition) {
      commands.push(definition);
      return () => {};
    }
  },
  typert: {
    register(descriptor) {
      typert.push(descriptor);
      return () => {};
    }
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    }
  },
  settings: {
    update(ns, patch) {
      settingsWrites.push({ ns, patch });
      // The real Loader reconciles the profile patch and then writes each volatile
      // field in place, which is what makes the live Config instance the plugin
      // reads from reflect a save. Mirror that so the probe checks the real path.
      for (const [key, value] of Object.entries(patch)) {
        const field = config[key];
        const write = field && Object.getOwnPropertySymbols(field).find((symbol) => String(symbol).includes("volatile.write"));
        if (write) field[write](value);
      }
      return Promise.resolve();
    },
    configure(policy) {
      configured = policy;
      return () => {};
    }
  },
  connection: {
    requestRejection() {
      return undefined;
    }
  },
  llm: {
    listProviders: () => [],
    listModels: () => Promise.resolve([]),
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 128000 } })
  },
  tokenMeter: { measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }), estimateMessage: () => 0 },
  sessionProjections: { stateOf: () => undefined },
  agents: { get: () => undefined },
  registry: { values: () => [] },
  waterfall: (_name, payload, fallback) => fallback()
};

module.apply(ctx, config);

// --- what apply must have registered ---------------------------------------
assert.deepEqual(commands.map((row) => row.name), ["fast-compact"],
  "exactly one command: the fold inspector was removed as redundant with the card");
assert.equal(typeof commands[0].handler, "function");
assert.match(commands[0].description, /fast-compact/);

const http = routes.find((row) => row.path === "/api/dsh-compact-manager/v1");
assert.ok(http, "the browser half's HTTP route must be registered");
assert.equal(http.kind, "exact");
assert.equal(typeof http.handler, "function");

assert.ok(provided.has("compactManager"), "remote service must be provided");
assert.ok(provided.has("compactionRoutes"), "route registry must be provided");

const service = provided.get("compactManager");
assert.equal(typeof service.getState, "function");
assert.equal(typeof service.saveConfig, "function");
assert.equal(typeof service.getHealth, "function");
assert.equal(typeof service.getPressure, "function");
assert.ok(service.typertRemote, "service needs its remote descriptor bundle");

assert.equal(typert.length, 1);
// The registry rejects a descriptor without an explicit face before it looks at
// anything else, so this is the first thing the probe must pin down.
assert.equal(typert[0].face, "host", "typert requires face=host");
assert.ok(typert[0].model?.services?.length, "typert needs a service model");
assert.equal(typert[0].model.services[0].key, "compactManager");
const descriptorNames = typert[0].invocations.map((row) => row.method).sort();
assert.deepEqual(descriptorNames, ["getHealth", "getPressure", "getState", "getStatus", "saveConfig"]);
for (const row of typert[0].invocations) {
  for (const parameter of row.parameters) {
    // api-gateway rejects a non-strict parameter codec; typert rejects a strict
    // codec without create(). Both failures abort client activation.
    assert.equal(parameter.codec.mode, "strict", `${row.method}.${parameter.name} must be a strict codec`);
    assert.equal(typeof parameter.codec.create, "function", `${row.method}.${parameter.name} needs create()`);
  }
  assert.equal(row.result.mode, "src-json");
}

// --- ingress hook -----------------------------------------------------------
const preStep = listeners.find((row) => row.event === "agent/pre-step");
assert.ok(preStep, "ingress shaping must hook agent/pre-step");
assert.equal(preStep.options?.prepend, true, "ingress must run before the request is assembled");

// --- settings policy --------------------------------------------------------
assert.deepEqual(configured, { auto: false }, "the plugin page replaces the auto-generated form");

// --- health shape -----------------------------------------------------------
const health = service.getHealth();
for (const key of ["version", "sessionApi", "config", "ingress", "shaping", "compaction", "hook"]) {
  assert.ok(key in health, `health.${key} must be present`);
}
for (const key of ["ok", "shaped", "snapped", "savedTokens", "failures", "lastError"]) {
  assert.ok(key in health.ingress, `health.ingress.${key} must be present`);
}
// The pane reports both strategies, split the way the plugin works. Counting only
// folds once made the model path look like it never ran; a missing field must fail
// here rather than be defaulted at render time, because the split shape is the
// contract the pane reads.
for (const key of ["compactions", "failures", "savedTokens", "lastBefore", "lastAfter"]) {
  assert.ok(key in health.compaction.model, `health.compaction.model.${key} must be present`);
  assert.equal(typeof health.compaction.model[key], "number", `health.compaction.model.${key} must be a number`);
}
for (const key of ["manual", "replaced", "live"]) {
  assert.ok(key in health.compaction.mechanical, `health.compaction.mechanical.${key} must be present`);
  assert.equal(typeof health.compaction.mechanical[key], "number", `health.compaction.mechanical.${key} must be a number`);
}
// The two groups are disjoint strategies; a shared counter would be double-counted.
assert.equal("manual" in health.compaction.model, false, "the model group must not carry fold counters");
for (const key of ["live", "wrapped", "mechanicalFolds", "replacedFolds", "unsupported", "unsupportedEngines"]) {
  assert.ok(key in health.hook, `health.hook.${key} must be present`);
}

// --- settings save round-trip ----------------------------------------------
const saved = await service.saveConfig({ provider: "p", model: "m", engine: "ledger", ingress: false });
assert.equal(settingsWrites.length, 1, "save must go through one update");
assert.equal(settingsWrites[0].ns, "dsh-compact-manager");
// Every known field is written, because update() merges rather than replaces.
for (const key of Object.keys(config)) {
  assert.ok(key in settingsWrites[0].patch, `patch must carry ${key}`);
}
assert.equal(saved.engine, "ledger");
assert.equal(saved.ingress, false);
assert.equal(saved.provider, "p");

console.log(`OK: ${effects.length} effects, ${listeners.length} event hooks, ${commands.length} command, ${routes.length} route`);
console.log(`    service methods: ${descriptorNames.join(", ")}`);
