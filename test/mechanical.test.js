/**
 * Tests for the merged compaction path.
 *
 * The unit tests in `ledger.test.js` cover the fold card and the ingress shaper,
 * and `config.test.js` covers the decision table. What none of them exercise is
 * the thing the merge actually builds: a mechanical fold that runs as a real
 * `compactSurfaceRegion` transaction, sharing its marker triple and stability
 * checks with the model path.
 *
 * That needs a session stand-in with a real surface, a token meter that prices
 * nodes, and an agent that can run maintenance. The fakes below are deliberately
 * small but not lenient: they reject a malformed surface op and they do not let a
 * compaction marker pair stay open, because those are the two ways a wrong
 * implementation would corrupt a log instead of failing loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../lib/controller.js";
import { hookStats, noteFold, noteModel, noteModelFailure, noteModelTarget, resetFoldStats } from "../lib/ledger/hook.js";
import { DEFAULTS, settingsSchema } from "../lib/config.js";

/** A session with a surface, an append log, and the accessors the region code uses. */
function makeSession(messages) {
  const log = [];
  const nodes = [];
  let openTurn = null;
  let generation = 0;

  const session = {
    seq: 0,
    get surface() {
      return {
        nodes: [...nodes],
        get replaceGeneration() {
          return generation;
        }
      };
    },
    eventAt: (seq) => log.find((event) => event.seq === seq),
    snapshotEvents: (from) => log.filter((event) => event.seq >= from),
    requestHeader: () => ({
      config: { provider: "p", model: "m", maxTokens: 8192 },
      tools: [{ name: "read", description: "read a file" }]
    }),
    deriveEventMessage: (event) => event?.data?.message ?? null,
    append(type, data, options = {}) {
      const op = options.surfaceOp;
      if (op && typeof op === "object" && !("startSeq" in op)) {
        throw new Error(`session event "${type}" carries an invalid replace surfaceOp`);
      }
      const event = { seq: log.length, type, data, ...options };
      log.push(event);
      session.seq = log.length;
      if (type === "compaction/start") openTurn = data;
      if (type === "compaction/end") openTurn = null;
      if (op && typeof op === "object") {
        // Replacement: the card takes the place of every shadowed node.
        const at = nodes.indexOf(op.startSeq);
        const remove = nodes.findIndex((seq) => seq === op.endSeq) - at + 1;
        nodes.splice(at, remove, event.seq);
        generation += 1;
      } else if (!type.startsWith("compaction/")) {
        // Compaction markers are lifecycle records, not surface nodes; appending
        // them to the surface would make every fold look like it grew history.
        nodes.push(event.seq);
      }
      return event;
    },
    get openTurn() {
      return openTurn;
    },
    get log() {
      return log;
    }
  };

  for (const [index, message] of messages.entries()) {
    const event = { seq: index, type: index === 0 ? "system/message" : "user/message", data: { message } };
    log.push(event);
    nodes.push(index);
  }
  session.seq = log.length;
  return session;
}

/** Price each surface node by its text length; enough for range selection. */
function makeMeter() {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => {
        const text = JSON.stringify(session.eventAt(seq)?.data?.message ?? "");
        const tokens = Math.ceil(text.length / 4);
        return { seq, tokens, heuristicTokens: tokens };
      });
      const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
      return { nodes, surfaceTokens, totalTokens: surfaceTokens, baseline: { kind: "usage", tokens: surfaceTokens } };
    },
    estimateMessage: (message) => Math.ceil(JSON.stringify(message ?? "").length / 4)
  };
}

/** A user message big enough that the fold is strictly smaller than its input. */
function bigMessage(index) {
  const body = Array.from({ length: 40 }, (_, line) => `line ${line} of turn ${index} ` + "x".repeat(60)).join("\n");
  return { role: "user", content: [{ type: "text", text: `Goal ${index}\n${body}` }], source: { kind: "user" } };
}

function makeAgent(session, meter) {
  const agent = {
    session,
    options: { provider: "p", model: "m" },
    status: "idle",
    async runMaintenance(run) {
      return run(new AbortController().signal);
    }
  };
  return agent;
}

/**
 * Context slice sufficient for one engine binding plus the region dependencies.
 *
 * The engine fiber's own scope is what `binding.ctx` refers to, so it has to
 * expose the same services the root does — that is how the real preset isolate
 * behaves, and a root-only stub would hide a genuine scoping bug.
 */
function makeContext(session, meter, engine) {
  const effects = [];
  const services = {
    tokenMeter: meter,
    llm: { resolveModelInfo: (provider, model) => Promise.resolve({ provider, id: model, context: { contextWindow: 128000 }, defaultMaxTokens: 8192 }) },
    sessions: { flush: async () => {} }
  };
  const scoped = {
    tokenMeter: services.tokenMeter,
    llm: services.llm,
    sessions: services.sessions,
    waterfall: (_name, payload, fallback) => fallback(),
    get: (name) => services[name]
  };
  const fiber = { uid: 1, entry: { options: { name: "@deepseek-ai/dsh-compaction-basic" } }, ctx: { ...scoped, get: () => engine } };
  return {
    registry: { values: () => [{ fibers: [fiber] }] },
    tokenMeter: meter,
    llm: services.llm,
    sessionProjections: { stateOf: () => undefined },
    sessions: services.sessions,
    waterfall: (_name, payload, fallback) => fallback(),
    on: () => () => {},
    effect(fn) {
      effects.push(fn);
      const dispose = fn();
      return () => (typeof dispose === "function" ? dispose() : undefined);
    },
    effects
  };
}

function makeController(settingsOverride = {}) {
  const messages = [bigMessage(1), bigMessage(2), bigMessage(3), bigMessage(4)];
  const session = makeSession(messages);
  const meter = makeMeter();
  const engine = { compactRegion: async () => null, compactIfNeeded: async () => null, compactNow: async () => null };
  const ctx = makeContext(session, meter, engine);
  const config = { ...DEFAULTS, ...settingsOverride };
  const live = settingsSchema(config);
  const controller = new Controller(ctx, { get: () => live }, undefined);
  const agent = makeAgent(session, meter);
  return { controller, agent, session, meter, engine, config: live };
}

test("the mechanical fold writes the same marker triple as the model path", async () => {
  resetFoldStats();
  const { controller, agent, session } = makeController();

  const result = await controller.mechanical(agent, new AbortController().signal, undefined, { owner: null });

  assert.ok(result, "fold must produce a result");
  const types = session.log.map((event) => event.type);

  // start -> summary -> end, in that order, then the replacement body. Anything
  // else would not be readable by the history UI or undo.
  const start = types.indexOf("compaction/start");
  const summary = types.indexOf("compaction/summary");
  const end = types.indexOf("compaction/end");
  assert.ok(start !== -1, "compaction/start must be appended");
  assert.ok(summary > start, "summary must follow start");
  assert.ok(end > summary, "end must follow summary");
  assert.equal(types.filter((type) => type === "compaction/start").length, 1);
  assert.equal(types.filter((type) => type === "compaction/end").length, 1);

  const summaryEvent = session.log[summary];
  assert.equal(summaryEvent.data.provider, "dsh-compact-manager");
  assert.equal(summaryEvent.data.model, "local-ledger");
  const cardText = summaryEvent.data.summary[0].text;
  assert.ok(cardText.includes("[Snapcompact]"), "the card headline must identify the fold");
  assert.ok(cardText.includes("FILES") || cardText.includes("INTENTS") || cardText.includes("EXCERPT"),
    "the card must carry at least one section");

  // The replacement is recorded as a real surface op with the seq pair.
  const replace = session.log.find((event) => event.surfaceOp && typeof event.surfaceOp === "object");
  assert.ok(replace, "a replace surface op must be appended");
  assert.ok("startSeq" in replace.surfaceOp && "endSeq" in replace.surfaceOp);

  // No compaction may be left open, or the next one would be refused as busy.
  assert.equal(session.openTurn, null, "the marker pair must be closed");
});

test("the mechanical fold shrinks the surface and reports its own counters", async () => {
  resetFoldStats();
  const { controller, agent, session } = makeController();
  const before = session.surface.nodes.length;

  const result = await controller.mechanical(agent, new AbortController().signal, undefined, { owner: null });

  const after = session.surface.nodes.length;
  assert.ok(after < before, `surface must shrink (${before} -> ${after})`);
  assert.ok(result.shadowedSeqs.length > 0);
  assert.ok(result.shadowedTokenCount > 0);

  const stats = hookStats();
  assert.equal(stats.mechanicalFolds, 1);
  assert.equal(stats.replacedFolds, 0);
});

test("a replaceDefault fold is counted separately from a manual one", async () => {
  resetFoldStats();
  const { controller, agent } = makeController();

  await controller.mechanical(agent, new AbortController().signal, undefined, { owner: null, replaced: true });

  const stats = hookStats();
  assert.equal(stats.replacedFolds, 1);
  assert.equal(stats.mechanicalFolds, 0);
});

test("the fold leaves the surface untouched when it cannot shrink", async () => {
  resetFoldStats();
  // One node only: there is nothing to compact, and `selectCompactableRange`
  // must refuse rather than replace the only message with a card.
  const session = makeSession([bigMessage(1)]);
  const meter = makeMeter();
  const engine = { compactRegion: async () => null, compactIfNeeded: async () => null, compactNow: async () => null };
  const ctx = makeContext(session, meter, engine);
  const controller = new Controller(ctx, { get: () => settingsSchema({}) }, undefined);
  const agent = makeAgent(session, meter);
  const before = session.surface.nodes.length;

  await assert.rejects(
    () => controller.mechanical(agent, new AbortController().signal, undefined, { owner: null }),
    /历史不足|no safe|compactable/i
  );
  assert.equal(session.surface.nodes.length, before, "a refused fold must not touch the surface");
  assert.equal(session.log.filter((event) => event.type === "compaction/start").length, 0,
    "a refused fold must not leave a marker behind");
});

test("the model path is not reachable while nothing is configured", () => {
  const { controller } = makeController();
  // Without a model the request must be routed to the fold rather than failing
  // at request time with an empty provider.
  assert.equal(controller.chooseFor(controller.settings.get()), "ledger");
});

test("state exposes the strategy so the footer can explain itself", () => {
  const { controller } = makeController({ provider: "p", model: "m" });
  const state = controller.state();
  assert.equal(state.engine, "saviour");
  assert.equal(state.config.provider, "p");
  assert.deepEqual(state.job, { phase: "idle", message: "", failures: 0 });
  assert.equal(state.available, false, "no agent is open in this controller");
});

test("one fold at a time per session", async () => {
  resetFoldStats();
  const { controller, agent } = makeController();
  const first = controller.mechanical(agent, new AbortController().signal, undefined, { owner: null });
  // The job's abort controller is set synchronously before the first await, so a
  // second call in the same tick must be refused instead of interleaving markers.
  await assert.rejects(
    () => controller.mechanical(agent, new AbortController().signal, undefined, { owner: null }),
    /已有压缩任务/
  );
  await first;
});

test("cancel aborts a running fold without committing", async () => {
  resetFoldStats();
  const { controller, agent, session } = makeController();
  const abort = new AbortController();
  const running = controller.mechanical(agent, abort.signal, undefined, { owner: null });
  abort.abort(new Error("stop"));
  await assert.rejects(() => running);
  // No card may be committed; a start marker that was written stays closed.
  const summaries = session.log.filter((event) => event.type === "compaction/summary");
  assert.equal(summaries.length, 0, "an aborted fold must not commit a summary");
  const starts = session.log.filter((event) => event.type === "compaction/start");
  const ends = session.log.filter((event) => event.type === "compaction/end");
  assert.equal(starts.length, ends.length, "every start must be matched by an end");
});

test("noteFold counts only the two known kinds", () => {
  resetFoldStats();
  noteFold("manual");
  noteFold("replaced");
  noteFold("idle");
  noteFold("nonsense");
  const stats = hookStats();
  assert.equal(stats.mechanicalFolds, 1, "only an explicit manual fold counts");
  assert.equal(stats.replacedFolds, 1);
  resetFoldStats();
});

test("a model compaction is counted, with its saving derived from before/after", () => {
  resetFoldStats();
  noteModel(100000, 40000);
  const stats = hookStats();
  assert.equal(stats.modelCompactions, 1);
  assert.equal(stats.modelSavedTokens, 60000);
  assert.equal(stats.lastModelBefore, 100000);
  assert.equal(stats.lastModelAfter, 40000);
  assert.equal(stats.modelFailures, 0);
});

test("a model compaction that grew the request reports zero saved, never a negative", () => {
  resetFoldStats();
  // A summarizer can return a card longer than a very short region. A negative
  // "saved" total in the pane would read as a bug rather than as a small region.
  noteModel(5000, 7000);
  const stats = hookStats();
  assert.equal(stats.modelSavedTokens, 0);
  assert.equal(stats.lastModelBefore, 5000);
  assert.equal(stats.lastModelAfter, 7000);
});

test("model savings accumulate across runs while the last-run pair does not", () => {
  resetFoldStats();
  noteModel(100000, 40000);
  noteModel(90000, 30000);
  const stats = hookStats();
  assert.equal(stats.modelCompactions, 2);
  assert.equal(stats.modelSavedTokens, 120000, "both runs add up");
  assert.equal(stats.lastModelBefore, 90000, "the last-run line shows only the newest run");
  assert.equal(stats.lastModelAfter, 30000);
});

test("failures are counted apart from successes", () => {
  resetFoldStats();
  noteModel(100000, 40000);
  noteModelFailure();
  const stats = hookStats();
  assert.equal(stats.modelCompactions, 1, "a failure must not inflate the success count");
  assert.equal(stats.modelFailures, 1);
});

test("the two fold kinds are reported separately, not summed", () => {
  resetFoldStats();
  noteFold("manual");
  noteFold("replaced");
  noteFold("replaced");
  const stats = hookStats();
  assert.equal(stats.mechanicalFolds, 1, "the pane must be able to tell a manual fold from a takeover");
  assert.equal(stats.replacedFolds, 2);
});

test("resetFoldStats clears every counter, including the model ones", () => {
  noteModel(1000, 200);
  noteModelFailure();
  resetFoldStats();
  const stats = hookStats();
  // Each field resets to its own zero: numbers to 0, the model-identity strings to
  // "", and the fallback flag to false. A blanket `= 0` would leave "false" as 0 and
  // make the pane render a boolean as a number.
  for (const [key, value] of Object.entries(stats)) {
    const expected = typeof value === "string" ? "" : typeof value === "boolean" ? false : 0;
    assert.equal(value, expected, `${key} must reset`);
  }
});

test("the last model that ran is recorded, with its separate counters", () => {
  resetFoldStats();
  noteModelTarget({ provider: "workbuddy", model: "space-bunny", reasoningEffort: "low" });
  const stats = hookStats();
  assert.equal(stats.lastModelProvider, "workbuddy");
  assert.equal(stats.lastModelId, "space-bunny");
  assert.equal(stats.lastModelEffort, "low");
  assert.ok(stats.lastModelAt > 0);
  assert.equal(stats.lastModelFellBack, false);
});

test("a fallback run names both the model that failed and the one that answered", () => {
  // Showing only the surviving model would hide that the fallback fired, which is
  // the one thing a two-model configuration exists to make observable.
  resetFoldStats();
  noteModelTarget({
    provider: "q",
    model: "backup",
    fellBack: true,
    failedProvider: "p",
    failedModel: "primary"
  });
  const stats = hookStats();
  assert.equal(stats.lastModelFellBack, true);
  assert.equal(stats.lastModelId, "backup", "the recorded model is the one that answered");
  assert.equal(stats.lastModelFailedId, "primary", "the failure source is kept for display");
  assert.equal(stats.lastModelFailedProvider, "p");
});

test("a later successful run clears the previous fallback flag", () => {
  resetFoldStats();
  noteModelTarget({ provider: "q", model: "backup", fellBack: true, failedProvider: "p", failedModel: "primary" });
  noteModelTarget({ provider: "p", model: "primary" });
  const stats = hookStats();
  assert.equal(stats.lastModelFellBack, false, "the flag describes the run it belongs to, not history");
  assert.equal(stats.lastModelFailedId, "");
});
