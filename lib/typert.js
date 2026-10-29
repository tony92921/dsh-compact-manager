/**
 * Remote descriptors for the browser half.
 *
 * The client cannot call a Host service directly; `ctx.remote.$mount()` publishes
 * a namespace whose every method is described here. Three validators run at
 * mount time:
 *
 * - `typert` requires `face: "host"` (and rejects anything else by name), plus
 *   `schemas` / `invocations` / `model` — an incomplete bundle fails activation
 *   with "invalid face undefined", which reads like a version mismatch but is
 *   only a missing field.
 * - `requireStrictInputs` (api-gateway) rejects a *parameter* codec whose `mode`
 *   is not `"strict"`, so parameters cannot be `src-json`.
 * - `validateCodec` rejects a strict codec without a `create()` factory, while
 *   letting `src-json` results through untouched.
 *
 * Parameters therefore carry a strict codec with a pass-through `create()`, while
 * results stay untyped JSON. All of it is evaluated during client activation,
 * which the Web boot audit treats as a failed startup, not a missing widget.
 */

import { PACKAGE, SERVICE } from "./config.js";

const json = Object.freeze({ mode: "src-json" });

/** A strict codec for one untyped JSON parameter. */
function strictJson(symbol) {
  return {
    mode: "strict",
    typeSymbol: PACKAGE + "#" + symbol,
    create: () => ({ parse(value) { return value; } })
  };
}

/** `[method, parameter names]` — the single table both halves derive from. */
const SPECS = [
  ["getState", []],
  ["saveConfig", ["config"]],
  ["getHealth", []],
  ["getStatus", ["sessionId"]],
  ["getPressure", ["sessionId"]]
];

const invocations = SPECS.map(([method, parameters]) => ({
  id: PACKAGE + "#" + SERVICE + "/" + method,
  service: SERVICE,
  namespace: SERVICE,
  method,
  invocation: { kind: "direct" },
  parameters: parameters.map((name) => ({
    name,
    wire: name,
    source: "json",
    codec: strictJson(SERVICE + "/" + method + ":" + name)
  })),
  result: json
}));

/** Method signatures the registry echoes back through its model. */
const members = SPECS.map(([method, parameters]) => ({
  kind: "method",
  name: method,
  signature: "@Remote('" + method + "') " + method + "(" + parameters.join(", ") + "): Promise<JsonValue>"
}));

export const TYPERT = {
  package: PACKAGE,
  face: "host",
  schemas: [],
  invocations,
  model: {
    services: [{
      description: "独立压缩模型 + 本地机械折页。",
      summary: "Merged compaction service.",
      tags: [],
      jsDoc: "Dedicated-model compaction plus a local mechanical fold.",
      key: SERVICE,
      exportName: "CompactSaviourLedgerService",
      members,
      types: []
    }],
    events: [],
    objects: []
  }
};

export default TYPERT;
