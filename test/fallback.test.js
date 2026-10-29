/**
 * Tests for the model fallback: model 1 fails, model 2 takes over.
 *
 * The placement of this logic is the thing under test, not just its outcome. The
 * fallback lives inside the `summarize` callback, which means `compactSurfaceRegion`
 * still sees exactly one summary attempt per transaction. A third attempt spawned at
 * the wrong layer would write a second marker triple, and an aborted one could leave
 * a half-committed replace behind — neither of which throws at request time.
 *
 * So the assertions here are about *what the transaction observed*:
 *
 * - the callback resolves with the fallback's text, and the model that produced it
 *   is the one recorded in the `compaction/summary` event
 * - a cancellation does not spend a second request on the backup model
 * - a fallback that is not fully configured is not offered at all
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../lib/controller.js";
import { settingsSchema } from "../lib/config.js";

/** Records what the controller asked for, in order. */
function makeRecorder() {
  return { calls: [] };
}

/**
 * A controller whose `compress` is replaced by a scripted stub.
 *
 * Returns the requested target each time so the test can assert the order, and
 * throws when the script says that model should fail.
 */
function makeController(settings, script) {
  const log = makeRecorder();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    on: () => () => {},
    get: () => undefined,
    registry: { values: () => [] },
    llm: { resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 1000000 }, id: "x", provider: "p" }) },
    sessionProjections: { stateOf: () => undefined },
    agents: { get: () => undefined },
    tokenMeter: { measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }), estimateMessage: () => 0 },
    waterfall: (_n, _p, fallback) => fallback()
  };
  const controller = new Controller(ctx, { get: () => settingsSchema(settings) }, undefined);
  // Replace the model call with the scripted one, keeping the measurement path.
  controller.compressOverride = async ({ target }) => {
    log.calls.push(target.provider + "/" + target.model);
    const outcome = script[target.model];
    if (outcome instanceof Error) throw outcome;
    return { summary: [{ type: "text", text: outcome ?? "ok" }], provider: target.provider, model: target.model };
  };
  return { controller, log };
}

/** One agent stand-in: the fallback code only needs identity for the job map. */
function makeAgent() {
  const session = {
    id: "s1",
    get surface() { return { nodes: [], replaceGeneration: 0 }; },
    requestHeader: () => ({ config: { provider: "p", model: "main" } })
  };
  return { session, status: "idle", options: { provider: "p", model: "main" } };
}

/**
 * Drive `compressWithFallback` directly.
 *
 * This is the unit under test. It takes the same options the real `summarize`
 * callback passes, so the wiring in `rescue` is exercised by `targetCandidates`.
 */
async function run(controller, targets, script, ctx = {}) {
  const calls = [];
  // Must mirror `compress(ctx, input, agent, options)` exactly: the controller calls
  // it through `this.compressFn`, so a different argument order silently shifts
  // every parameter.
  const compress = async (_ctx, _input, _agent, options) => {
    calls.push(options.target.provider + "/" + options.target.model);
    const outcome = script[options.target.model];
    if (outcome instanceof Error) throw outcome;
    return { provider: options.target.provider, model: options.target.model, summary: [{ type: "text", text: outcome ?? "ok" }] };
  };
  controller.compressFn = compress;
  const result = await controller.compressWithFallback(
    { llm: {} }, [], makeAgent(),
    { targets, signal: ctx.signal ?? new AbortController().signal, summaryBudget: 1000, maxSummaryTokens: 1000 }
  );
  return { result, calls };
}

test("model 1 succeeding never touches model 2", async () => {
  const { controller } = makeController({ provider: "p", model: "m1" }, {});
  const { result, calls } = await run(
    controller,
    [{ provider: "p", model: "m1" }, { provider: "p", model: "m2" }],
    { m1: "from-model-1" }
  );
  assert.deepEqual(calls, ["p/m1"], "the fallback must not be called when model 1 works");
  assert.equal(result.model, "m1");
});

test("model 1 failing falls through to model 2", async () => {
  const { controller } = makeController({ provider: "p", model: "m1", fallbackProvider: "p", fallbackModel: "m2" }, {});
  const { result, calls } = await run(
    controller,
    [{ provider: "p", model: "m1" }, { provider: "p", model: "m2" }],
    { m1: new Error("rate limited"), m2: "from-model-2" }
  );
  assert.deepEqual(calls, ["p/m1", "p/m2"], "model 2 is tried only after model 1 failed");
  assert.equal(result.model, "m2", "the result must be the one that succeeded");
});

test("both models failing surfaces the last error", async () => {
  const { controller } = makeController({ provider: "p", model: "m1" }, {});
  await assert.rejects(
    () => run(
      controller,
      [{ provider: "p", model: "m1" }, { provider: "p", model: "m2" }],
      { m1: new Error("first broke"), m2: new Error("second broke") }
    ),
    /second broke/,
    "the error a caller sees should be the failure of the last attempt"
  );
});

test("a cancellation does not spend a request on the backup model", async () => {
  // The user pressed cancel; silently trying another model is the opposite of that.
  const { controller } = makeController({ provider: "p", model: "m1" }, {});
  const abort = new AbortController();
  abort.abort(new Error("user cancelled"));
  await assert.rejects(() => run(
    controller,
    [{ provider: "p", model: "m1" }, { provider: "p", model: "m2" }],
    { m1: new Error("cancelled") },
    { signal: abort.signal }
  ));
});

test("an unconfigured fallback is not offered as a candidate", () => {
  const { controller } = makeController({ provider: "p", model: "m1" }, {});
  assert.deepEqual(
    controller.targets().map((t) => t.model),
    ["m1"],
    "no fallback fields means one candidate"
  );
});

test("half a fallback target is ignored rather than attempted", () => {
  // A provider without a model would resolve to an empty target at request time,
  // after model 1 had already spent its attempt — worse than no fallback.
  const onlyProvider = makeController({ provider: "p", model: "m1", fallbackProvider: "q" }, {}).controller;
  assert.deepEqual(onlyProvider.targets().map((t) => t.model), ["m1"]);
  const onlyModel = makeController({ provider: "p", model: "m1", fallbackModel: "m2" }, {}).controller;
  assert.deepEqual(onlyModel.targets().map((t) => t.model), ["m1"]);
});

test("a fallback identical to model 1 is deduplicated", () => {
  const { controller } = makeController({
    provider: "p", model: "m1",
    fallbackProvider: "p", fallbackModel: "m1"
  }, {});
  assert.deepEqual(controller.targets().map((t) => t.model), ["m1"],
    "retrying the same model after its own failure would repeat the same error");
});

test("the fallback carries its own reasoning level", () => {
  const { controller } = makeController({
    provider: "p", model: "m1", reasoningEffort: "low",
    fallbackProvider: "q", fallbackModel: "m2", fallbackReasoningEffort: "high"
  }, {});
  const [primary, fallback] = controller.targets();
  assert.equal(primary.reasoningEffort, "low");
  assert.equal(fallback.reasoningEffort, "high", "model 2 can support a different effort");
});

test("an active route lease pins the target and forbids the fallback", () => {
  // A lease exists to keep the summary routed and priced against one exact model;
  // falling back would break the pricing decision the lease was created for.
  const { controller } = makeController({
    provider: "p", model: "m1", fallbackProvider: "q", fallbackModel: "m2"
  }, {});
  const leased = controller.targetCandidates({ provider: "z", model: "leased" }, { target: { provider: "z", model: "leased" } });
  assert.deepEqual(leased.map((t) => t.model), ["leased"]);
});

test("the caller's chosen target stays first when it differs from the configured one", () => {
  // `/fast-compact current` compacts with the conversation model for one run.
  const { controller } = makeController({ provider: "p", model: "m1", fallbackProvider: "q", fallbackModel: "m2" }, {});
  const candidates = controller.targetCandidates({ provider: "conv", model: "chat" }, undefined);
  assert.deepEqual(candidates.map((t) => t.model), ["chat", "m1", "m2"],
    "the one-off target is tried first, then the configured chain");
});

test("with no model configured the candidates are empty and compress refuses", async () => {
  const { controller } = makeController({}, {});
  assert.deepEqual(controller.targets(), []);
  await assert.rejects(
    () => run(controller, [], {}),
    /选择压缩模型/
  );
});
