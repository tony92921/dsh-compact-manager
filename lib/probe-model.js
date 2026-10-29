/**
 * Live probe for one configured compaction model.
 *
 * The settings page can validate that a provider/model pair *resolves* and that a
 * reasoning level *appears* in the adapter's list, but neither proves the model
 * actually answers. A route can be configured correctly and still fail on: a credit
 * balance, a revoked key, a rate limit, a model that rejects its own reasoning
 * parameter, or a summarizer that returns prose the assembler cannot use.
 *
 * So this sends one real, cheap request and reports what happened. Three design
 * choices matter more than the happy path:
 *
 * 1. **It is a real summarization request**, not a ping. The same `purpose`,
 *    `source`, system prompt and instruction shape the compaction path uses, so a
 *    model that would fail during a real compaction fails here too. A plain
 *    "say hello" would pass while the actual job failed.
 * 2. **It changes nothing.** No session log is written, no cache is touched, no job
 *    state moves. A test button must be safe to press on a live conversation.
 * 3. **The input length is the user's choice.** Small models with a small summary
 *    budget fail on long input while succeeding on short input, and that difference
 *    is the whole point of testing before trusting a model with a 1M-token history.
 */

const SYSTEM = "You are a context compactor. Summarize the transcript you are given.";

/**
 * Rounds of filler to send, and roughly how many tokens each costs.
 *
 * The round counts are calibrated against `buildTranscript`: a round is about 320
 * characters ≈ 90 tokens, so these five land near 200 / 2k / 100k / 300k / 900k.
 * They are deliberately *not* round numbers of rounds — the labels promise a token
 * count, and a label that overstates the request would make a slow result look
 * unexplained.
 *
 * The top size is 900k, not 1M, because the window is not all input. A 1M-window
 * model still needs room for the output budget and the system prompt, so a probe
 * sized at exactly 1M could never fit any model and would report every one of them
 * as broken at the validate step. 900k leaves ~100k of headroom for those.
 *
 * `tiny` is a cheap smoke test, not a substitute for the larger sizes: it proves the
 * route answers at all, which is a different question from whether the model can
 * compact a real history. The sizes above it are the ones that answer that.
 */
export const SIZES = [
  { id: "tiny", label: "极小（≈200 tok）", rounds: 3, tokenHint: 200, timeoutMs: 90_000 },
  { id: "small", label: "小（≈2k tok）", rounds: 22, tokenHint: 2000, timeoutMs: 120_000 },
  { id: "medium", label: "中（≈100k tok）", rounds: 1102, tokenHint: 100000, timeoutMs: 240_000 },
  { id: "large", label: "大（≈300k tok）", rounds: 3275, tokenHint: 300000, timeoutMs: 420_000 },
  { id: "full", label: "全量（≈900k tok）", rounds: 9794, tokenHint: 900000, timeoutMs: 900_000 }
];

/** Resolve a size id to its definition, defaulting to the smallest. */
export function resolveSize(id) {
  return SIZES.find((size) => size.id === id) ?? SIZES[0];
}

/**
 * Build a transcript of approximately the requested size.
 *
 * Filler is deterministic rather than random so a failure can be reproduced: the
 * same model, size and settings produce the same request, which makes the elapsed
 * time comparable between runs.
 */
export function buildTranscript(rounds) {
  const lines = [];
  for (let index = 0; index < rounds; index += 1) {
    const turn = String(index + 1).padStart(3, "0");
    lines.push(`### step ${turn}`);
    lines.push(`user: Please inspect module ${turn} and report the failing assertion.`);
    lines.push(`tool: opened src/module-${turn}.ts (${40 + (index % 7) * 10} lines)`);
    lines.push(`assistant: Found the off-by-one at line ${12 + index % 40}; the loop reads one element past the end.`);
    lines.push(`tool: patched src/module-${turn}.ts, 1 insertion 1 deletion`);
    lines.push(`assistant: Fixed. The suite now passes for module ${turn}.`);
  }
  lines.push("user: Summarize everything above into a compact handoff.");
  return lines.join("\n");
}

/**
 * Probe one target.
 *
 * @param ctx - Host context; only `llm` is used.
 * @param options.target - `{ provider, model, reasoningEffort? }`.
 * @param options.size - a `SIZES` id.
 * @param options.signal - optional outer cancellation.
 * @returns A result object; failures are returned, not thrown, because the button
 *   needs to render the reason rather than surface an exception.
 */
export async function probeModel(ctx, options = {}) {
  const { target, size, signal, llm = ctx?.llm } = options;
  const started = Date.now();
  const spec = resolveSize(size);

  if (!target?.provider || !target?.model) {
    return { ok: false, error: "没有配置这个模型。", ms: 0, size: spec.id };
  }
  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, error: "当前 Host 没有可用的 llm 服务。", ms: 0, size: spec.id };
  }

  // Resolve metadata first so a bad provider/model is reported as such instead of
  // as a scalar "stream failed" later.
  let info;
  try {
    info = await llm.resolveModelInfo(target.provider, target.model, signal);
  } catch (error) {
    return { ok: false, error: messageOf(error), ms: Date.now() - started, size: spec.id, phase: "resolve" };
  }
  if (!info) {
    return { ok: false, error: "解析不到模型信息。", ms: Date.now() - started, size: spec.id, phase: "resolve" };
  }

  // A reasoning level the adapter does not offer is a configuration error that only
  // shows up at request time, so catch it here with the list of valid values.
  const efforts = info.reasoning?.efforts ?? [];
  if (target.reasoningEffort && efforts.length && !efforts.some((effort) => effort.id === target.reasoningEffort)) {
    return {
      ok: false,
      error: `该模型不支持 reasoning level "${target.reasoningEffort}"（可用：${efforts.map((e) => e.id).join(", ")}）。`,
      ms: Date.now() - started,
      size: spec.id,
      phase: "validate"
    };
  }

  const transcript = buildTranscript(spec.rounds);
  const contextWindow = info.context?.contextWindow;
  const maxTokens = Math.max(256, Math.min(1024, Math.floor((contextWindow ?? 8192) * 0.05)));

  // Refuse a probe the model cannot hold before spending the request on it.
  //
  // The largest sizes exist to prove a long history survives a real compaction, and a
  // model with a 128k window would fail them at the provider with an opaque error
  // after uploading megabytes. Estimating here turns that into a one-line answer, and
  // it is the answer the user actually wants: "this model cannot compact this
  // conversation at all".
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    const estimated = Math.ceil(transcript.length / 3.5);
    const needed = estimated + maxTokens;
    if (needed > contextWindow) {
      // The message names the *shrink* the user needs to pick, not just the failure:
      // "需要小一档" is the actionable half, because the next size down will usually
      // fit. The system prompt and the wrapper text are counted in `maxTokens`'s
      // favour only implicitly, so the advice keeps a margin rather than promising
      // the exact boundary.
      const fit = SIZES.filter((size) => size.rounds < spec.rounds
        && Math.ceil(buildTranscript(size.rounds).length / 3.5) + maxTokens <= contextWindow).pop();
      return {
        ok: false,
        ms: Date.now() - started,
        size: spec.id,
        sizeLabel: spec.label,
        contextWindow,
        error: `输入约 ${Math.round(estimated / 1000)}k tok + 输出预算 ${maxTokens} 超过该模型的 ${Math.round(contextWindow / 1000)}k 窗口，这一档测不了它。`
          + (fit ? `改用「${fit.label}」这一档。` : "该窗口连最小档都放不下。"),
        phase: "validate"
      };
    }
  }

  let text = "";
  let assembler;
  try {
    const { BlockAssembler, createUserMessage } = await loadLlmHelpers();
    assembler = new BlockAssembler();
    const request = {
      provider: target.provider,
      model: target.model,
      ...target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {},
      system: SYSTEM,
      messages: [createUserMessage({
        content: [{
          type: "text",
          text: `Summarize this transcript into at most ${maxTokens} tokens.\n\n<transcript-data>\n${transcript}\n</transcript-data>`
        }],
        source: { kind: "plugin:dsh-compact-manager" }
      })],
      maxTokens,
      purpose: "compaction",
      // Prefill dominates a large probe: 1M tokens spends minutes in the provider's
      // queue before the first output token, so a single fixed timeout would report
      // a healthy model as broken. The budget grows with the advertised size, and a
      // "full" probe is allowed the full 15 minutes.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(spec.timeoutMs)])
        : AbortSignal.timeout(spec.timeoutMs)
    };
    for await (const chunk of llm.stream(request)) {
      if (signal?.aborted) throw new Error("已取消。");
      assembler.push(chunk);
    }
    if (assembler.finish?.kind === "error" || assembler.finish?.kind === "aborted") {
      throw new Error(assembler.finish.failure?.message || "请求未正常结束。");
    }
    text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  } catch (error) {
    return { ok: false, error: messageOf(error), ms: Date.now() - started, size: spec.id, phase: "request" };
  }

  const ms = Date.now() - started;
  if (!text) {
    return { ok: false, error: "模型返回了空内容。", ms, size: spec.id, phase: "request" };
  }
  const usage = assembler?.usage;
  return {
    ok: true,
    ms,
    size: spec.id,
    sizeLabel: spec.label,
    model: `${target.provider}/${target.model}`,
    ...target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {},
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    contextWindow,
    // A short preview is enough to tell "answered" from "answered with prose that is
    // not a summary"; the full text would swamp the settings page.
    preview: text.slice(0, 240),
    chars: text.length
  };
}

/**
 * Load the two llm helpers lazily.
 *
 * They are imported here rather than at module scope so the resolver stays usable in
 * a test harness that stubs `ctx.llm` but cannot resolve the real package.
 */
async function loadLlmHelpers() {
  const mod = await import("@deepseek-ai/dsh-llm");
  return { BlockAssembler: mod.BlockAssembler, createUserMessage: mod.createUserMessage };
}

function messageOf(error) {
  if (!error) return "未知错误";
  const text = error instanceof Error ? error.message : String(error);
  // Providers nest the useful part: "fetch failed" often hides a 401 one level down.
  const cause = error?.cause?.message;
  return cause && !text.includes(cause) ? `${text}（${cause}）` : text;
}
