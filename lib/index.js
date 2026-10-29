/**
 * dsh-compact-manager — Host half.
 *
 * One plugin, two compaction strategies, one settings page and one status
 * surface. Before this merge they were two plugins:
 *
 * - dsh-compact-saviour: a dedicated model that compacts on demand, rescues after
 *   the official engine fails twice, and can replace the automatic path outright.
 * - dsh-ledger-compact: local shaping of oversized `tool_result` blocks before
 *   they are ever sent, plus a mechanical fold that rewrites old history into a
 *   card with no model call.
 *
 * Both wrapped the same official engine, so whichever loaded second shadowed the
 * first and the ledger had to restore prototype methods to reach its own code
 * path. `Controller` now owns all three engine entry points and chooses a
 * strategy per call, which is why there is exactly one wrapper here.
 *
 * @module dsh-compact-manager
 */

import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { Config, DEFAULTS, ENGINES, NS, PACKAGE, SERVICE, VERSION, settingsSchema } from "./config.js";
import { Controller } from "./controller.js";
import { CompactionRouteRegistry } from "./routes.js";
import { getService, hasEventAccessor } from "./ledger/ctx.js";
import { shapeCurrentTurnIngress } from "./ledger/ingress.js";
import { formatFoldNotice, formatTokenCount } from "./ledger/fold.js";
import { resolveVisionRoute } from "./ledger/vision.js";
import { SIZES, probeModel } from "./probe-model.js";
import { describeThreshold, resolveThreshold } from "./threshold.js";
import { TYPERT } from "./typert.js";

export const name = PACKAGE;
export const inject = [
  "agents",
  "llm",
  "tokenMeter",
  "settings",
  "sessionProjections",
  "webServer",
  "connection",
  "commands",
  "typert"
];

/**
 * Settings schema the browser form and the HTTP `/settings` route validate with.
 *
 * `Config` already declares every field; this plain-schema twin exists because
 * the save route coerces an arbitrary JSON body, and running it through a fresh
 * `z.object` gives the same defaults and bounds the Host uses without touching
 * the live Config instance.
 */
const SaveSchema = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  mode: z.union(["rescue", "direct"]).default(DEFAULTS.mode),
  provider: z.string().default(DEFAULTS.provider),
  model: z.string().default(DEFAULTS.model),
  reasoningEffort: z.string().default(DEFAULTS.reasoningEffort),
  fallbackProvider: z.string().default(DEFAULTS.fallbackProvider),
  fallbackModel: z.string().default(DEFAULTS.fallbackModel),
  fallbackReasoningEffort: z.string().default(DEFAULTS.fallbackReasoningEffort),
  rescueAfterFailures: z.number().min(1).max(5).default(DEFAULTS.rescueAfterFailures),
  thresholdOverride: z.boolean().default(DEFAULTS.thresholdOverride),
  thresholdRatio: z.number().min(0.1).max(0.95).default(DEFAULTS.thresholdRatio),
  headroomTokens: z.number().min(0).max(400000).default(DEFAULTS.headroomTokens),
  retainRatio: z.number().min(0.02).max(0.5).default(DEFAULTS.retainRatio),
  ingress: z.boolean().default(DEFAULTS.ingress),
  snapImages: z.boolean().default(DEFAULTS.snapImages),
  imagePixelBudget: z.number().min(200000).max(4000000).default(DEFAULTS.imagePixelBudget),
  minSnapTokens: z.number().min(200).max(200000).default(DEFAULTS.minSnapTokens),
  savingsRatio: z.number().min(0.05).max(1).default(DEFAULTS.savingsRatio),
  confirmFold: z.boolean().default(DEFAULTS.confirmFold),
  replaceDefault: z.boolean().default(DEFAULTS.replaceDefault),
  engine: z.union(ENGINES).default(DEFAULTS.engine)
});

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("JSON required");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request too large");
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid request");
  return data;
}

/** Read every field of a schemastery Config instance into a plain object. */
function readConfig(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const field = config?.[key];
    if (field && typeof field.get === "function") out[key] = field.get();
  }
  return out;
}

/**
 * Any live agent, for callers that need a routed model but have no session id.
 *
 * The threshold preview needs a context window, which only a routed model can
 * supply; with no session open there is still a sensible answer as long as one
 * agent exists, and answering beats refusing to render the page.
 */
function firstAgent(ctx) {
  try {
    for (const agent of ctx.agents.list?.() ?? []) return agent;
  } catch {
    // A service surface without list() is not an error worth failing the request.
  }
  return undefined;
}

/**
 * Parse `/fast-compact [ledger|saviour|auto|mechanical|status]`.
 *
 * Module-level rather than nested in `apply` so the accepted grammar is testable
 * without a full Host context. `mechanical` is accepted as an alias for `ledger`
 * because that is the label the second popup button uses, and users type what
 * they see.
 */
export function parseCommand(rawInput) {
  const text = String(rawInput ?? "").trim();
  if (!text) return { op: "fold", engine: "" };
  const parts = text.split(/\s+/);
  if (parts[0] === "status") return { op: "status", engine: "" };
  if (parts.length === 1 && (ENGINES.includes(parts[0]) || parts[0] === "mechanical")) {
    return { op: "fold", engine: parts[0] === "mechanical" ? "ledger" : parts[0] };
  }
  return { op: "error", text: "用法：/fast-compact [ledger|saviour|auto] | /fast-compact status" };
}

export function apply(ctx, config) {
  /** Settings facade shared by the controller, the routes and the command. */
  const settings = {
    get: () => settingsSchema(readConfig(config)),
    /**
     * Persist a whole settings object.
     *
     * `settings.update(ns, patch)` merges fields instead of replacing the
     * section, so every known key is sent on purpose: the page saves one value at
     * a time and a partial patch would leave a stale sibling in place.
     */
    replace: (value) => ctx.settings.update(NS, settingsSchema(value))
  };
  ctx.effect(() => ctx.settings.configure({ auto: false }));

  const routes = new CompactionRouteRegistry();
  ctx.provide("compactionRoutes", routes);
  ctx.effect(() => () => routes.close());

  const controller = new Controller(ctx, settings, routes);

  /** Ingress health, read by the diagnostics pane and `/fast-compact status`. */
  const health = {
    sessionApi: "",
    ingress: { ok: true, failures: 0, lastError: "", shaped: 0, snapped: 0, savedTokens: 0, at: 0 }
  };
  const noteIngressFailure = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const ingress = health.ingress;
    ingress.ok = false;
    ingress.failures += 1;
    ingress.at = Date.now();
    if (ingress.lastError !== message) {
      ingress.lastError = message;
      ctx.logger?.warn?.("dsh-compact-manager: ingress shaping failed: " + message);
    }
  };

  async function visionRouteFor(agent, live, signal) {
    const routed = controller.current(agent);
    let inputModalities;
    if (routed?.provider && routed.model) {
      try {
        const info = await ctx.llm.resolveModelInfo(routed.provider, routed.model, signal);
        inputModalities = info?.inputModalities;
      } catch {
        inputModalities = undefined;
      }
    }
    return resolveVisionRoute({
      mainProvider: routed?.provider ?? "",
      mainModel: routed?.model ?? "",
      inputModalities,
      snapImages: live.snapImages
    });
  }

  /**
   * Shape oversized tool results from the step that just finished.
   *
   * Prepend on purpose: this runs before the request that would first carry those
   * results is assembled, which is the only point where rewriting them cannot
   * invalidate a provider-cached prefix.
   */
  ctx.effect(() => ctx.on("agent/pre-step", async (payload, next) => {
    const live = settings.get();
    const agent = payload?.agent;
    if (live.ingress && agent?.session) {
      health.sessionApi = hasEventAccessor(agent.session) ? "eventAt" : "events";
      try {
        const route = await visionRouteFor(agent, live, payload.signal);
        const report = await shapeCurrentTurnIngress(agent.session, ctx, {
          turn: payload.turn,
          step: payload.step,
          vision: route.ingressVision,
          model: route.mainModel,
          minSnapTokens: live.minSnapTokens,
          savingsRatio: live.savingsRatio,
          imagePixelBudget: live.imagePixelBudget
        });
        if (report.failed > 0) noteIngressFailure(new Error(report.error || "ingress append failed"));
        if (report.shaped > 0) {
          const ingress = health.ingress;
          ingress.ok = true;
          ingress.shaped += report.shaped;
          ingress.snapped += report.snapped;
          ingress.savedTokens += report.tokensSaved;
          ingress.at = Date.now();
        }
      } catch (error) {
        noteIngressFailure(error);
      }
    }
    return next();
  }, { prepend: true }), "dsh-compact-manager: ingress");

  /**
   * Health payload for the diagnostics tab.
   *
   * Every field is filled here rather than left to the renderer: a missing key
   * would throw during render, and React answers a render throw by unmounting the
   * whole settings dialog.
   *
   * The shape is grouped the way the pane renders it, because the flat list it
   * replaced put ingress shaping and compaction stats on the same rows and made
   * eight unrelated numbers look like one table.
   */
  function getHealth() {
    const hooks = controller.foldStats();
    return {
      version: VERSION,
      sessionApi: health.sessionApi || "unknown",
      config: settings.get(),
      ingress: { ...health.ingress },
      // Ingress shaping: rewrites oversized tool results before their first send.
      shaping: { ...health.ingress },
      // Both compaction strategies, so the pane cannot imply only one ever runs.
      compaction: {
        model: {
          compactions: hooks.modelCompactions,
          failures: hooks.modelFailures,
          savedTokens: hooks.modelSavedTokens,
          lastBefore: hooks.lastModelBefore,
          lastAfter: hooks.lastModelAfter,
          // Which model produced the most recent summary. Reported from the committed
          // result rather than from settings, so a fallback run shows model 2 — the
          // whole point of having two configured models is knowing which one answered.
          last: {
            provider: hooks.lastModelProvider,
            model: hooks.lastModelId,
            reasoningEffort: hooks.lastModelEffort,
            at: hooks.lastModelAt,
            fellBack: hooks.lastModelFellBack,
            failedProvider: hooks.lastModelFailedProvider,
            failedModel: hooks.lastModelFailedId
          }
        },
        mechanical: {
          manual: hooks.mechanicalFolds,
          replaced: hooks.replacedFolds,
          live: hooks.live
        }
      },
      hook: {
        live: hooks.live,
        wrapped: hooks.mechanicalFolds + hooks.replacedFolds + hooks.modelCompactions,
        unsupported: 0,
        unsupportedEngines: [],
        mechanicalFolds: hooks.mechanicalFolds,
        replacedFolds: hooks.replacedFolds
      }
    };
  }

  // ---------------------------------------------------------------------------
  // `/fast-compact`
  // ---------------------------------------------------------------------------

  /** Parse `/fast-compact [ledger|saviour|auto|status]`. */
  function isManualCompactionError(error) {
    return Boolean(error && error.name === "ManualCompactionError" && typeof error.code === "string");
  }

  function expectedFailure(error) {
    switch (error.code) {
      case "busy":
        return { kind: "error", text: "压缩暂不可用：已有压缩在跑，或 agent 不在空闲状态。" };
      case "cancelled":
        return { kind: "error", text: "压缩已取消。" };
      case "changed":
        return { kind: "error", text: "准备压缩的历史在替换前变了，对话未改动。" };
      case "summary":
        return { kind: "error", text: "没有生成比原文更短的摘要，对话未改动。" };
      case "commit":
        return { kind: "error", text: "压缩没有干净地收尾，重试前先检查当前会话。" };
      case "persistence":
        return { kind: "error", text: "压缩完成了，但会话没能保存。" };
      default:
        return { kind: "error", text: "压缩失败：" + error.message };
    }
  }

  function formatStatus(agent) {
    const live = settings.get();
    const lines = [
      `fast-compact: engine=${live.engine} mode=${live.enabled ? live.mode : "off"}`
        + ` model=${live.provider ? live.provider + "/" + live.model : "none"}`
        + ` fallback=${live.fallbackProvider ? live.fallbackProvider + "/" + live.fallbackModel : "none"}`
        + ` rescue=${live.mode === "direct" ? "n/a" : live.rescueAfterFailures}`
        + ` ingress=${live.ingress ? "on" : "off"}`
        + ` replace=${live.replaceDefault ? "on" : "off"}`
        + ` snap=${live.snapImages ? "on" : "off"}`
        + ` confirm=${live.confirmFold ? "on" : "off"}`
    ];
    if (agent) {
      try {
        const state = controller.state(agent.session.id);
        lines.push(`  context: ${state.job.phase}${state.job.message ? " · " + state.job.message : ""} · available=${state.available}`);
      } catch (error) {
        lines.push("  context: " + (error instanceof Error ? error.message : String(error)));
      }
      lines.push(`  engines hooked: ${controller.bindings.size} live`);
    }
    // Both strategies, because a status line that only showed folds is what made
    // the model path look dormant in the pane.
    const counts = controller.foldStats();
    lines.push(`  runs: model=${counts.modelCompactions} (fail ${counts.modelFailures}, saved≈${formatTokenCount(counts.modelSavedTokens)} tok)`
      + ` · manual fold=${counts.mechanicalFolds} · replaced fold=${counts.replacedFolds}`);
    // The trigger is the one setting whose effect is invisible until it fires, so
    // the status line prints the resolved number rather than the three inputs.
    lines.push(`  trigger: ${live.thresholdOverride ? "override" : "official"}`
      + ` ratio=${(live.thresholdRatio * 100).toFixed(0)}% headroom=${live.headroomTokens} retain=${(live.retainRatio * 100).toFixed(0)}%`);
    const ingress = health.ingress;
    if (ingress.ok === false) lines.push(`  ingress FAILING (${ingress.failures}): ${ingress.lastError || "unknown error"}`);
    else if (!ingress.shaped) lines.push("  ingress idle: 还没有足够大的 tool_result");
    else lines.push(`  ingress ok: shaped ${ingress.shaped}${ingress.snapped ? " snapped " + ingress.snapped : ""}${ingress.savedTokens ? " saved≈" + ingress.savedTokens + " tok" : ""}`);
    return lines.join("\n");
  }

  const active = new Set();
  const handler = (invocation) => {
    const operation = (async () => {
      const parsed = parseCommand(invocation.rawInput);
      if (parsed.op === "error") return { kind: "error", text: parsed.text };
      if (parsed.op === "status") return { kind: "success", text: formatStatus(invocation.agent) };
      const live = settings.get();
      const engine = controller.chooseFor(live, parsed.engine);
      try {
        const agent = invocation.agent;
        const result = await agent.runMaintenance((agentSignal) => {
          const signal = AbortSignal.any([invocation.signal, agentSignal]);
          return engine === "ledger"
            ? controller.mechanical(agent, signal, invocation.commandId, { owner: null, replaced: live.replaceDefault })
            : controller.rescue(agent, controller.binding(agent), controller.configured(live), signal, true, undefined, invocation.commandId);
        });
        if (result === null || result === undefined) {
          return { kind: "success", text: engine === "ledger" ? "暂无可折页的历史。" : "暂无可压缩的历史。" };
        }
        if (engine !== "ledger") {
          const items = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
          const tokens = Number(result.shadowedTokenCount) || 0;
          return {
            kind: "success",
            text: `已压缩 ${items} 条历史（约 ${formatTokenCount(tokens)} tokens）· 引擎: ${result.model ? result.provider + "/" + result.model : "Saviour"}`,
            sourceEventSeq: result.summarySeq
          };
        }
        const notice = formatFoldNotice(result);
        return { kind: "success", text: notice, sourceEventSeq: result.summarySeq };
      } catch (error) {
        if (invocation.signal.aborted) return { kind: "error", text: "压缩已取消。" };
        if (isManualCompactionError(error)) return expectedFailure(error);
        throw error;
      }
    })();
    active.add(operation);
    const retire = () => { active.delete(operation); };
    operation.then(retire, retire);
    return operation;
  };

  ctx.effect(() => ctx.commands.register({
    name: "fast-compact",
    description: "选择本次压缩引擎：/fast-compact [ledger|saviour|auto]，或 /fast-compact status。破坏性操作，优先用输入栏按钮确认。",
    input: { hint: "ledger | saviour | auto | status" },
    handler
  }), "dsh-compact-manager: command");

  ctx.effect(() => () => Promise.allSettled(active), "dsh-compact-manager: drain");

  // ---------------------------------------------------------------------------
  // Remote service + HTTP
  // ---------------------------------------------------------------------------

  /** Remote face consumed by the pressure gauge and the diagnostics tab. */
  const service = {
    getState() {
      return { ...settings.get(), version: VERSION };
    },
    saveConfig(next) {
      return settings.replace(next).then(() => ({ ...settings.get(), version: VERSION }));
    },
    getHealth,
    getStatus(sessionId) {
      return { ...settings.get(), version: VERSION, text: formatStatus(sessionId ? ctx.agents.get(sessionId) : undefined) };
    },
    getPressure(sessionId) {
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined;
      if (!agent) return Promise.resolve({ used: 0, window: 0, percent: 0, compactable: 0, rawTok: 0, fill: 0 });
      return controller.context(sessionId).then((context) => ({
        used: Number(context?.usedTokens) || 0,
        window: Number(context?.contextWindow) || 0,
        percent: context?.contextWindow ? Math.floor((context.usedTokens * 100) / context.contextWindow) : 0,
        compactable: 0,
        rawTok: 0,
        fill: context?.contextWindow ? Math.min(1, Math.max(0, context.usedTokens / context.contextWindow)) : 0
      }));
    }
  };
  service.typertRemote = { service, serviceKey: SERVICE, namespace: SERVICE };
  ctx.provide(SERVICE, service);
  ctx.typert.register(TYPERT);

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-compact-manager/v1",
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection) {
        json(res, rejection, { error: "Unauthorized" });
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site"
        || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
        json(res, 403, { error: "Forbidden" });
        return;
      }
      try {
        const url = new URL(req.url, "http://localhost");
        if (req.method === "GET") {
          if (url.searchParams.get("models") === "1") {
            const results = await Promise.allSettled(ctx.llm.listProviders().map((provider) => ctx.llm.listModels(provider.id)));
            // `sizes` ships with the model list so the page cannot drift from the
            // lengths the probe actually supports.
            json(res, 200, {
              models: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
              sizes: SIZES
            });
            return;
          }
          if (url.searchParams.has("provider") && url.searchParams.has("model")) {
            const info = await ctx.llm.resolveModelInfo(url.searchParams.get("provider"), url.searchParams.get("model"));
            json(res, 200, {
              efforts: info.reasoning?.efforts ?? [],
              contextWindow: info.context?.contextWindow,
              defaultEffort: info.reasoning?.defaultEffort
            });
            return;
          }
          if (url.searchParams.get("health") === "1") {
            json(res, 200, getHealth());
            return;
          }
          // Threshold preview: the settings page renders the resolved trigger from
          // the same resolver the Host enforces with, instead of a display copy of
          // the formula that could drift away from the real decision.
          if (url.searchParams.get("threshold") === "1") {
            const id = url.searchParams.get("sessionId") ?? undefined;
            const agent = id ? ctx.agents.get(SessionId(id)) : undefined;
            const pending = {
              thresholdRatio: Number(url.searchParams.get("ratio") ?? settings.get().thresholdRatio),
              headroomTokens: Number(url.searchParams.get("headroom") ?? settings.get().headroomTokens),
              retainRatio: Number(url.searchParams.get("retain") ?? settings.get().retainRatio)
            };
            const live = settings.get();
            const probe = agent ?? firstAgent(ctx);
            const target = probe ? controller.current(probe) : undefined;
            let info;
            if (target?.provider && target.model) {
              try {
                info = await ctx.llm.resolveModelInfo(target.provider, target.model);
              } catch {
                info = undefined;
              }
            }
            const window = info?.context?.contextWindow
              ?? (Number(url.searchParams.get("window")) || 0);
            const header = probe?.session?.requestHeader?.();
            const reserved = header?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0;
            const spec = resolveThreshold(window, reserved, {
              ...pending,
              // The form may be dirty while the saved config is not; the preview must
              // fall back to the saved values, not to the resolver's own defaults, or
              // an untouched field would preview a number nothing will use.
              thresholdRatio: Number.isFinite(pending.thresholdRatio) ? pending.thresholdRatio : live.thresholdRatio,
              headroomTokens: Number.isFinite(pending.headroomTokens) ? pending.headroomTokens : live.headroomTokens,
              retainRatio: Number.isFinite(pending.retainRatio) ? pending.retainRatio : live.retainRatio
            });
            json(res, 200, {
              spec,
              text: describeThreshold(spec),
              model: target ? { provider: target.provider, model: target.model } : null,
              reservedTokens: reserved
            });
            return;
          }
          if (url.searchParams.get("probe") === "1") {
            // Which of the two configured models to probe. `2` falls back to the
            // fallback fields; an unknown value is rejected rather than defaulted,
            // because a typo silently testing model 1 would look like a pass.
            const which = url.searchParams.get("model") ?? "1";
            if (which !== "1" && which !== "2") {
              json(res, 400, { error: "model must be 1 or 2" });
              return;
            }
            const live = settings.get();
            const target = which === "1"
              ? { provider: live.provider, model: live.model, ...(live.reasoningEffort ? { reasoningEffort: live.reasoningEffort } : {}) }
              : { provider: live.fallbackProvider, model: live.fallbackModel, ...(live.fallbackReasoningEffort ? { reasoningEffort: live.fallbackReasoningEffort } : {}) };
            const abort = new AbortController();
            // The browser can go away mid-probe; the request must not keep a model
            // call running against a page nobody is looking at.
            req.on?.("close", () => abort.abort(new Error("已取消。")));
            const result = await probeModel(ctx, {
              target,
              size: url.searchParams.get("size") ?? "tiny",
              signal: abort.signal
            });
            json(res, 200, result);
            return;
          }
          const id = url.searchParams.get("sessionId") ?? undefined;
          json(res, 200, {
            ...controller.state(id),
            engine: controller.chooseFor(settings.get()),
            health: getHealth(),
            context: await controller.context(id)
          });
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        const data = await readBody(req);
        if (data.action === "settings") {
          const value = SaveSchema(data.config);
          if ((value.provider === "") !== (value.model === "")) throw new Error("请选择完整的压缩模型。");
          // The fallback is optional, but never half-configured: a provider without a
          // model would resolve to an empty target at request time, after model 1 had
          // already spent its attempt.
          if ((value.fallbackProvider === "") !== (value.fallbackModel === "")) {
            throw new Error("请选择完整的备用模型，或两个都留空。");
          }
          if (value.provider) {
            const info = await ctx.llm.resolveModelInfo(value.provider, value.model);
            if (value.reasoningEffort && !info.reasoning?.efforts.some((effort) => effort.id === value.reasoningEffort)) {
              throw new Error("不支持这个 reasoning level。");
            }
          }
          if (value.fallbackProvider) {
            const info = await ctx.llm.resolveModelInfo(value.fallbackProvider, value.fallbackModel);
            if (value.fallbackReasoningEffort && !info.reasoning?.efforts.some((effort) => effort.id === value.fallbackReasoningEffort)) {
              throw new Error("备用模型不支持这个 reasoning level。");
            }
          }
          await settings.replace(value);
          json(res, 200, { ...controller.state(), config: settings.get() });
          return;
        }
        if (typeof data.sessionId !== "string" || !["configured", "current", "cancel", "mechanical"].includes(String(data.action))) {
          throw new Error("Invalid action");
        }
        json(res, 200, controller.request(data.sessionId, data.action));
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }), "dsh-compact-manager: http");

  ctx.logger?.info?.(`dsh-compact-manager v${VERSION} loaded`);
}

export { Config };
export default { apply, inject, name, Config };
