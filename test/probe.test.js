/**
 * Tests for the connectivity probe.
 *
 * A test button that lies is worse than no button: it either declares a broken
 * model healthy or a healthy one broken, and the user trusts it precisely because
 * it claims to have tried. So the assertions here are about honesty:
 *
 * - a request that the adapter rejects is reported as a failure with the reason
 * - a reasoning level the model does not offer is caught before the request, and
 *   the message lists what *is* available
 * - a model that answers with empty text is a failure, not a pass
 * - an unconfigured model says so instead of silently probing model 1
 *
 * The stubbed `llm.stream` lets each of those be produced deterministically, which
 * is the only way to test error handling without owning a broken provider.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SIZES, buildTranscript, probeModel, resolveSize } from "../lib/probe-model.js";

/**
 * A `ctx.llm` stand-in.
 *
 * `script` decides what the stream does: a string is emitted as one text chunk, an
 * Error is thrown, and an `{ finish: "length" }` marker ends the assembler without
 * a stop, which is how a truncated response presents itself.
 */
function makeLlm(script, info = {}) {
  const calls = [];
  return {
    calls,
    resolveModelInfo: async (provider, model) => {
      if (info.resolveError) throw info.resolveError;
      return {
        provider,
        id: model,
        context: { contextWindow: info.contextWindow ?? 200000 },
        reasoning: info.efforts ? { efforts: info.efforts.map((id) => ({ id, name: id })) } : undefined,
        defaultMaxTokens: 8192
      };
    },
    stream(request) {
      calls.push(request);
      return (async function* () {
        if (script instanceof Error) throw script;
        // The real stream speaks in deltas and ends with a `finish` chunk; a
        // `block`/`block-end` shape is not a chunk variant BlockAssembler accepts, so
        // the double must use the real grammar or it tests a path that never runs.
        if (script === "empty") {
          yield { type: "text-delta", index: 0, text: "" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "text-delta", index: 0, text: script };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
}

const TARGET = { provider: "p", model: "m" };

test("a healthy model reports ok, elapsed time and a preview", async () => {
  const llm = makeLlm("Goal: fix the loop. Files: module-1.ts.");
  const result = await probeModel({ llm }, { target: TARGET, size: "tiny" });
  assert.equal(result.ok, true, result.error);
  assert.equal(typeof result.ms, "number");
  assert.ok(result.ms >= 0);
  assert.match(result.preview, /fix the loop/);
  assert.equal(result.model, "p/m");
});

test("the request is shaped like a real compaction, not a ping", async () => {
  // A plain "hello" would pass while the actual summarization job failed, so the
  // probe must carry the same purpose and a transcript payload.
  const llm = makeLlm("ok");
  await probeModel({ llm }, { target: TARGET, size: "tiny" });
  const request = llm.calls[0];
  assert.equal(request.purpose, "compaction");
  assert.match(request.system, /compactor/i);
  const text = request.messages[0].content[0].text;
  assert.match(text, /<transcript-data>/, "the model must receive a transcript to summarize");
  assert.ok(request.maxTokens > 0);
});

test("a provider error is reported with its message, not swallowed", async () => {
  const llm = makeLlm(new Error("402 insufficient credits"));
  const result = await probeModel({ llm }, { target: TARGET, size: "tiny" });
  assert.equal(result.ok, false);
  assert.match(result.error, /insufficient credits/);
  assert.equal(result.phase, "request");
});

test("an unresolvable model fails at the resolve phase", async () => {
  const llm = makeLlm("ok", { resolveError: new Error("unknown model m") });
  const result = await probeModel({ llm }, { target: TARGET, size: "tiny" });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "resolve");
  assert.match(result.error, /unknown model/);
});

test("an unsupported reasoning level is caught before spending a request", async () => {
  const llm = makeLlm("ok", { efforts: ["low", "high"] });
  const result = await probeModel({ llm }, {
    target: { ...TARGET, reasoningEffort: "xhigh" },
    size: "tiny"
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "validate");
  assert.match(result.error, /xhigh/);
  assert.match(result.error, /low, high/, "the message must list what the model does support");
  assert.equal(llm.calls.length, 0, "no request may be spent on a known-bad configuration");
});

test("a supported reasoning level is passed through to the request", async () => {
  const llm = makeLlm("ok", { efforts: ["low", "high"] });
  const result = await probeModel({ llm }, {
    target: { ...TARGET, reasoningEffort: "high" },
    size: "tiny"
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(llm.calls[0].reasoningEffort, "high");
});

test("an empty answer is a failure, not a pass", async () => {
  // A model that accepts the request and returns nothing usable would break a real
  // compaction at the summarizer, so the probe must not call that healthy.
  const llm = makeLlm("empty");
  const result = await probeModel({ llm }, { target: TARGET, size: "tiny" });
  assert.equal(result.ok, false);
  assert.match(result.error, /空/);
});

test("an unconfigured model is refused instead of probing another one", async () => {
  const llm = makeLlm("ok");
  const blank = await probeModel({ llm }, { target: { provider: "", model: "" }, size: "tiny" });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /没有配置/);
  assert.equal(llm.calls.length, 0);
});

test("a host without an llm service reports that, not a crash", async () => {
  const result = await probeModel({}, { target: TARGET, size: "tiny" });
  assert.equal(result.ok, false);
  assert.match(result.error, /llm/);
});

test("the requested length changes how much transcript is sent", async () => {
  const small = makeLlm("ok", { contextWindow: 1_200_000 });
  await probeModel({ llm: small }, { target: TARGET, size: "tiny" });
  const large = makeLlm("ok", { contextWindow: 1_200_000 });
  await probeModel({ llm: large }, { target: TARGET, size: "large" });
  const smallText = small.calls[0].messages[0].content[0].text;
  const largeText = large.calls[0].messages[0].content[0].text;
  assert.ok(largeText.length > smallText.length * 10,
    `large (${largeText.length}) must be far bigger than tiny (${smallText.length})`);
});

test("a probe larger than the model's window is refused before it is sent", async () => {
  // A 128k model cannot compact a 900k-token conversation, and the provider's own
  // error arrives only after the whole transcript has been uploaded. Saying so
  // first is both cheaper and more useful.
  const llm = makeLlm("ok", { contextWindow: 128000 });
  const result = await probeModel({ llm }, { target: TARGET, size: "full" });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "validate");
  assert.match(result.error, /128k/);
  // The refusal must also say which size would work: "测不了" alone leaves the user
  // guessing whether any option fits their model.
  assert.match(result.error, /改用「中（≈100k tok）」这一档/, "the error must name the largest size that fits");
  assert.equal(llm.calls.length, 0, "no request may be spent on a probe that cannot fit");
});

test("the top size fits a 1M-window model", async () => {
  // The regression this pins: the top size was 1M, so on a model advertising exactly
  // a 1M window the input plus the output budget was over the limit, and the largest
  // option could never pass on any model — it always reported "这一档测不了它".
  // The window is shared between input and output, so the probe must leave room.
  const llm = makeLlm("ok", { contextWindow: 1_000_000 });
  const result = await probeModel({ llm }, { target: TARGET, size: "full" });
  assert.equal(result.ok, true, result.error);
  assert.equal(llm.calls.length, 1, "a 1M-window model must actually be probed at the top size");
});

test("every advertised size is usable on a model whose window matches its label", async () => {
  // Each size claims a token count; a model with a window at least that large plus
  // the output budget must be able to run it. This catches a future size whose label
  // and rounds drift apart, or one sized at the full window like the old 1M entry.
  for (const size of SIZES) {
    const llm = makeLlm("ok", { contextWindow: size.tokenHint + 8192 });
    const result = await probeModel({ llm }, { target: TARGET, size: size.id });
    assert.equal(result.ok, true,
      `${size.id} (${size.label}) must fit a window of its own advertised size + 8192; got: ${result.error}`);
  }
});

test("the same model still passes a probe that fits its window", async () => {
  const llm = makeLlm("ok", { contextWindow: 128000 });
  const result = await probeModel({ llm }, { target: TARGET, size: "medium" });
  assert.equal(result.ok, true, result.error);
  assert.equal(llm.calls.length, 1);
});

test("a bigger probe gets a longer timeout than a small one", () => {
  // Prefill time scales with input, so one fixed budget would report a healthy
  // model as broken as soon as the user picks a large size.
  const byId = new Map(SIZES.map((size) => [size.id, size.timeoutMs]));
  assert.ok(byId.get("tiny") < byId.get("medium"), "medium must outlast tiny");
  assert.ok(byId.get("medium") < byId.get("large"), "large must outlast medium");
  assert.ok(byId.get("large") < byId.get("full"), "full must outlast large");
});

test("an unknown size id falls back to the smallest probe", () => {
  // A typo must not silently send a megabyte-token request and charge for it.
  assert.equal(resolveSize("nope").id, "tiny");
  assert.equal(resolveSize(undefined).id, "tiny");
});

test("every advertised size builds a transcript of a plausible length", () => {
  for (const size of SIZES) {
    const text = buildTranscript(size.rounds);
    assert.ok(text.length > 0, `${size.id} must produce text`);
    // Rough sanity: 3-5 chars per token, so the character count should sit within a
    // wide band around the advertised token hint. This catches a rounds/tokenHint
    // mismatch, not exact pricing.
    const estimate = text.length / 4;
    assert.ok(estimate > size.tokenHint * 0.25 && estimate < size.tokenHint * 4,
      `${size.id}: ${Math.round(estimate)} estimated tokens vs hint ${size.tokenHint}`);
  }
});

test("the transcript is deterministic so timings are comparable", () => {
  assert.equal(buildTranscript(8), buildTranscript(8));
  assert.notEqual(buildTranscript(8), buildTranscript(9));
});
