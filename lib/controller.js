/**
 * One controller for both compaction strategies.
 *
 * Both strategies wrap the same `@deepseek-ai/dsh-compaction-basic` engine, and
 * they need different entry points to do it:
 *
 * - The model path replaces `compactRegion` / `compactIfNeeded` / `compactNow` so
 *   every path runs its own multi-chunk model summarizer.
 * - The mechanical path patches `engine.summarize` so a fold can short-circuit it,
 *   and reaches `/fast-compact ledger` without going through the model wrapper.
 *
 * Two independent wrappers cannot coexist cleanly: whichever installs second
 * shadows the first, so the mechanical path would have to restore prototype
 * methods at call time to reach its own code. One wrapper owns all three entry
 * points here and chooses a strategy per call, so the fold is a first-class
 * sibling of the model path instead of something layered underneath it.
 *
 * Strategy selection, in one place (`chooseFor`):
 *
 * | setting            | automatic pressure/overflow | manual button, `/compact`, `/fast-compact` |
 * |--------------------|-----------------------------|--------------------------------------------|
 * | `replaceDefault`   | mechanical fold             | mechanical fold                            |
 * | `mode: direct`     | backup model                | per `engine`                               |
 * | `mode: rescue`     | official, model after 2 fail| per `engine`                               |
 * | `engine: ledger`   | n/a                         | mechanical fold                            |
 * | `engine: saviour`  | n/a                         | backup model                               |
 * | `engine: auto`     | n/a                         | model if one is configured, else fold      |
 *
 * A fold and a model compaction both go through `compactSurfaceRegion`, so both
 * write the same `compaction/start` + `compaction/summary` + `compaction/end`
 * marker triple and the same surface-op shape. Only the summarizer differs.
 */

import { SessionId } from "@deepseek-ai/dsh-session";
import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
import { errorChain } from "@deepseek-ai/dsh-llm";
import { compactSurfaceRegion, compress, selectCompactableRange } from "./compact-core.js";
import { PressureMeter } from "./pressure.js";
import { foldSummary, formatFoldNotice, formatTokenCount } from "./ledger/fold.js";
import { hookStats, noteFold, noteModel, noteModelFailure, noteModelTarget } from "./ledger/hook.js";
import { resolveThreshold } from "./threshold.js";

const inactive = () => ({ view: { phase: "idle", message: "", failures: 0 }, blocked: false });

export class Controller {
  /** Engine bindings keyed by the owning fiber, so HMR and disposal can restore them. */
  bindings = new Map();
  jobs = new Map();
  disposed = false;

  /**
   * @param ctx - plugin context; supplies the registry, events and services.
   * @param settings - live merged settings accessor.
   * @param routes - optional fiber-owned compaction route registry.
   */
  constructor(ctx, settings, routes) {
    this.ctx = ctx;
    this.settings = settings;
    this.routes = routes;
    this.pressure = new PressureMeter(ctx);
    const scan = () => {
      if (!this.disposed) this.scan();
    };
    ctx.on("internal/status", () => queueMicrotask(scan), { global: true });
    ctx.on("agent/created", async () => {
      scan();
    }, { global: true });
    ctx.on("agent/disposed", ({ agent }) => {
      this.jobs.get(agent.session.id)?.abort?.abort();
      this.jobs.delete(agent.session.id);
    }, { global: true });
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const job = this.jobs.get(agent.session.id);
      if (job?.pending || job?.pendingMechanical) await this.runPending(agent, signal, false);
      return next();
    }, { global: true, prepend: true });
    ctx.on("agent/status", ({ agent, status }) => {
      const job = this.jobs.get(agent.session.id);
      if (status === "idle" && (job?.pending || job?.pendingMechanical)) {
        queueMicrotask(() => {
          void this.runIdle(agent);
        });
      }
    }, { global: true });
    ctx.effect(() => async () => {
      this.disposed = true;
      for (const job of this.jobs.values()) job.abort?.abort(new Error("插件已卸载。"));
      for (const binding of this.bindings.values()) binding.restore();
      await Promise.allSettled([...this.jobs.values()].map((job) => job.work));
      this.jobs.clear();
      this.bindings.clear();
    });
    scan();
  }

  job(agent) {
    let job = this.jobs.get(agent.session.id);
    if (!job) {
      job = inactive();
      this.jobs.set(agent.session.id, job);
    }
    return job;
  }

  /**
   * Install or refresh the per-instance wrapper on every live compaction engine.
   *
   * Each official engine fiber is decorated in place — no prototype, Loader row
   * or core-file mutation — and a dead fiber's binding is restored and dropped.
   * `compactNow` is what the manual buttons and `/compact` reach;
   * `compactRegion` is the automatic and overflow path; `compactIfNeeded` primes
   * the pressure meter before the official synchronous threshold check.
   */
  scan() {
    for (const [fiber, binding] of this.bindings) {
      if (fiber.uid === null) {
        binding.restore();
        this.bindings.delete(fiber);
      }
    }
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        const entry = fiber.entry;
        if (fiber.uid === null || this.bindings.has(fiber) || entry?.options.name !== "@deepseek-ai/dsh-compaction-basic") continue;
        const engine = fiber.ctx.get("compaction");
        if (!engine || typeof engine.compactRegion !== "function" || typeof engine.compactIfNeeded !== "function") continue;
        const originalRegion = engine.compactRegion;
        const originalIfNeeded = engine.compactIfNeeded;
        const ownRegion = Object.getOwnPropertyDescriptor(engine, "compactRegion");
        const ownNeeded = Object.getOwnPropertyDescriptor(engine, "compactIfNeeded");
        const ownNow = Object.getOwnPropertyDescriptor(engine, "compactNow");
        const self = this;
        const binding = { engine, ctx: fiber.ctx, fiber, restore() {} };

        const region = async function (start, end, agent, signal) {
          const job = self.job(agent);
          const config = self.settings.get();
          if (job.blocked && config.enabled) throw new Error("压缩救援等待用户选择重试或取消。");
          signal ??= new AbortController().signal;
          // `replaceDefault` is the hard override: no automatic path may call a
          // model while it is on, which is what makes "never spend tokens on
          // compaction" a promise the plugin can keep.
          if (config.replaceDefault) {
            return self.mechanical(agent, signal, undefined, { owner: "current-turn", range: { start, end }, replaced: true });
          }
          const route = config.enabled ? self.routes?.resolve(agent) : undefined;
          if (self.direct(config) || route) {
            return self.rescue(agent, binding, route?.target ?? self.configured(config), signal, false, { start, end }, undefined, route);
          }
          const generation = agent.session.surface.replaceGeneration;
          const firstEvent = agent.session.seq;
          try {
            const result = await originalRegion.call(this, start, end, agent, signal);
            job.view.failures = 0;
            return result;
          } catch (error) {
            // Never retry a partial commit, cancellation, or unmatched transaction.
            if (signal.aborted || agent.session.surface.replaceGeneration !== generation) throw error;
            const events = agent.session.snapshotEvents(firstEvent);
            if (!events.some((event) => event.type === "compaction/end" && event.data.error)
              || events.some((event) => event.type === "compaction/summary")) throw error;
            job.view.failures++;
            // The threshold is configurable because "official first" has a real cost:
            // every failed attempt is a full request spent on a summarizer that did
            // not work. Users who would rather not pay that twice can set it to 1.
            const live = self.settings.get();
            if (!live.enabled || job.view.failures < live.rescueAfterFailures) throw error;
            return self.rescue(agent, binding, self.configured(live), signal, false);
          }
        };

        const needed = async function (agent, trigger, signal) {
          if (self.job(agent).blocked && self.settings.get().enabled) return null;
          // Prime metadata before the official synchronous pressure check. Failure
          // to resolve it leaves the original check and context-overflow recovery intact.
          try {
            await self.pressure.refresh(agent.session, self.current(agent), signal);
          } catch (error) {
            if (signal?.aborted) throw error;
          }
          // The official engine freezes its own `thresholdRatio` / `headroomTokens` /
          // `retainRatio` at construction, so a settings page cannot change them
          // through the engine's Config. When the override is on, this plugin runs
          // the pressure decision itself with the configured numbers.
          const override = self.thresholdOverride(agent);
          if (override && trigger === "pressure") return self.pressureStep(agent, override, binding, signal);
          return originalIfNeeded.call(this, agent, trigger, signal);
        };

        const now = function (agent, signal, sourceCommandId) {
          signal.throwIfAborted();
          const config = self.settings.get();
          const chosen = self.chooseFor(config);
          return agent.runMaintenance((agentSignal) => {
            const merged = AbortSignal.any([signal, agentSignal]);
            if (chosen === "ledger") {
              return self.mechanical(agent, merged, sourceCommandId, { owner: null, replaced: config.replaceDefault });
            }
            return self.rescue(agent, binding, self.configured(config), merged, true, undefined, sourceCommandId);
          });
        };

        engine.compactRegion = region;
        engine.compactIfNeeded = needed;
        engine.compactNow = now;
        binding.restore = function restore() {
          if (Object.getOwnPropertyDescriptor(engine, "compactRegion")?.value === region) {
            if (ownRegion) Object.defineProperty(engine, "compactRegion", ownRegion);
            else Reflect.deleteProperty(engine, "compactRegion");
          }
          if (Object.getOwnPropertyDescriptor(engine, "compactIfNeeded")?.value === needed) {
            if (ownNeeded) Object.defineProperty(engine, "compactIfNeeded", ownNeeded);
            else Reflect.deleteProperty(engine, "compactIfNeeded");
          }
          if (Object.getOwnPropertyDescriptor(engine, "compactNow")?.value === now) {
            if (ownNow) Object.defineProperty(engine, "compactNow", ownNow);
            else Reflect.deleteProperty(engine, "compactNow");
          }
        };
        this.bindings.set(fiber, binding);
      }
    }
  }

  /**
   * The configured trigger, or `undefined` when the official thresholds should rule.
   *
   * `thresholdOverride` defaults to on so the settings page is authoritative the
   * moment a field is edited, but the default values reproduce compaction-basic's
   * own (`0.8` / `65536` / `0.16`), so an untouched install behaves identically.
   */
  thresholdOverride(agent) {
    const config = this.settings.get();
    if (!config.thresholdOverride) return undefined;
    return {
      thresholdRatio: config.thresholdRatio,
      headroomTokens: config.headroomTokens,
      retainRatio: config.retainRatio
    };
  }

  /**
   * Resolve the trigger for one agent, priced against its routed model.
   *
   * @returns the `resolveThreshold` spec, or `undefined` when no capacity is known.
   */
  async spec(agent, signal) {
    const target = this.current(agent);
    if (!target?.provider || !target.model) return undefined;
    let info;
    try {
      info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    } catch {
      return undefined;
    }
    const window = info?.context?.contextWindow;
    if (!window) return undefined;
    // Match compaction-basic exactly: the routed envelope's own cap wins, then the
    // adapter default. Using the config value keeps the trigger identical to what
    // the official code would compute with the same inputs.
    const header = agent.session.requestHeader();
    const reserved = header?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0;
    const settings = this.thresholdOverride(agent)
      ?? { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 };
    return resolveThreshold(window, reserved, settings);
  }

  /**
   * Run the automatic pressure decision with this plugin's thresholds.
   *
   * Replaces the official `compactIfNeeded("pressure", …)` body, which reads the
   * engine's frozen config. The order of operations is the same as the official
   * one — prune, re-measure, then decide — because the pruner can drop the request
   * below the trigger on its own, and skipping it would compact a request that no
   * longer needs it.
   *
   * @returns the compaction result, or `null` when the request is under the trigger.
   */
  async pressureStep(agent, override, binding, signal) {
    const spec = await this.spec(agent, signal);
    if (!spec || spec.known === false) return null;
    const meter = binding.ctx.tokenMeter;
    let measurement = meter.measure(agent.session);
    if (measurement.totalTokens < spec.thresholdTokens) return null;

    const prune = binding.ctx.get("toolResultPruner");
    if (prune?.pruneSession) {
      try {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      } catch {
        // A pruner that refuses is not a reason to skip compaction entirely; the
        // threshold check below still runs on the unpruned measurement.
      }
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null;

    const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
    if (!range) return null;
    return this.compactRegionFor(binding, range.start, range.end, agent, signal);
  }

  /**
   * Reach the plugin's own `compactRegion` wrapper on one engine binding.
   *
   * Kept as a method so `pressureStep` cannot accidentally call the *original*
   * region — doing so would run the official summarizer and skip both strategies.
   */
  compactRegionFor(binding, start, end, agent, signal) {
    const current = binding.engine.compactRegion;
    if (typeof current !== "function") throw new Error("压缩引擎未就绪。");
    return current.call(binding.engine, start, end, agent, signal);
  }

  /** The engine this agent's compaction call must reach. */
  binding(agent) {
    this.scan();
    const chain = scopeChainOf(agent);
    const ranked = [...this.bindings.values()].map((binding) => {
      const scope = scopeOf(binding.ctx);
      return { binding, rank: scope === undefined ? chain.length : chain.indexOf(scope) };
    }).filter((entry) => entry.rank >= 0).sort((a, b) => a.rank - b.rank);
    const matches = ranked.filter((entry) => entry.rank === ranked[0]?.rank).map((entry) => entry.binding);
    if (matches.length !== 1) throw new Error(`当前会话的官方 Compact 后端未就绪（匹配 ${matches.length} 个）。`);
    return matches[0];
  }

  /**
   * Which strategy one manual call uses. See the table in the module comment.
   *
   * @param config - live merged settings.
   * @param explicit - engine named on the command line, overriding the setting.
   * @returns `"ledger"` for the mechanical fold, `"saviour"` for the model path.
   */
  chooseFor(config, explicit) {
    if (explicit === "ledger" || explicit === "saviour") return explicit;
    if (config.replaceDefault) return "ledger";
    if (config.engine === "ledger" || config.engine === "saviour") return config.engine;
    // `auto`: a fold throws away detail, so it is only the default when there is
    // no model to compact with. Configuring a model is itself the opt-in.
    return config.provider && config.model ? "saviour" : "ledger";
  }

  configured(config = this.settings.get()) {
    const { provider, model, reasoningEffort } = config;
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  /**
   * The ordered list of models to try for one compaction run.
   *
   * Model 1 is the configured saviour model; model 2 is the optional fallback. A
   * fallback is only included when it is fully specified — half a target would fail
   * at request time with a "please choose a model" error *after* model 1 had already
   * burned its attempt, which is worse than not having a fallback at all.
   *
   * A duplicate fallback is dropped rather than kept: retrying the identical
   * provider/model after a failure just spends the same error twice.
   *
   * @returns a non-empty array when any model is configured, otherwise empty.
   */
  targets(config = this.settings.get()) {
    const primary = this.configured(config);
    const list = primary.provider && primary.model ? [primary] : [];
    const { fallbackProvider, fallbackModel, fallbackReasoningEffort } = config;
    if (fallbackProvider && fallbackModel) {
      const same = list.some((target) => target.provider === fallbackProvider && target.model === fallbackModel);
      if (!same) {
        list.push({
          provider: fallbackProvider,
          model: fallbackModel,
          ...(fallbackReasoningEffort ? { reasoningEffort: fallbackReasoningEffort } : {})
        });
      }
    }
    return list;
  }

  /**
   * The models to try for one run, given what the caller already selected.
   *
   * A route lease pins an exact provider/model for the whole compaction, so when one
   * is active the fallback must not override it: the lease exists precisely to keep
   * the summary priced and routed against one model. In that case only the leased
   * target is offered.
   *
   * @param target - the already-resolved primary (from the lease, or the context).
   * @param route - optional route lease.
   */
  targetCandidates(target, route) {
    if (route) return [target];
    const primary = target?.provider && target.model ? [target] : [];
    const list = [...this.targets()];
    // `targets()` may have a different primary than the caller's (the caller can
    // pass the conversation model for a one-off `/fast-compact current`), so keep the
    // caller's choice first and append whatever the fallback chain adds.
    const ordered = primary.length ? [target, ...list] : list;
    const seen = new Set();
    return ordered.filter((entry) => {
      if (!entry?.provider || !entry.model) return false;
      const key = entry.provider + "/" + entry.model;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Summarize with a fallback: model 1, then model 2 if it failed.
   *
   * The fallback lives *inside* the summarize callback rather than around
   * `compactSurfaceRegion`, and that placement is the whole design:
   *
   * - `compactSurfaceRegion` writes a compaction marker triple and a surface replace
   *   per attempt. Wrapping it would mean a failed model 1 leaves a marker pair that
   *   the next attempt must clean up, and a partial commit cannot be retried at all.
   * - Retrying inside the callback means the transaction sees exactly one summarize
   *   call. Whichever model produced the text, the surface op and markers are
   *   written once, by the same code path that already passes its stability checks.
   *
   * A cancelled run never falls through to model 2: the user asked to stop, and
   * silently spending a second request on the backup model is the opposite of that.
   *
   * @param options.targets - ordered models; index 0 is model 1.
   * @returns the `compress` result of whichever model succeeded.
   */
  async compressWithFallback(ctx, input, agent, options) {
    const targets = options.targets ?? [];
    if (!targets.length) throw new Error("请先在设置 → 压缩管理 中选择压缩模型。");
    // Resolved per call through this field so a test can substitute the model call
    // without patching the module graph. Production leaves it as the real import.
    const call = this.compressFn ?? compress;
    let lastError;
    for (const [index, target] of targets.entries()) {
      const { targets: _ignored, ...rest } = options;
      try {
        const result = await call(ctx, input, agent, { ...rest, target });
        if (index > 0) {
          this.job(agent).view = {
            ...this.job(agent).view,
            message: `模型 1 失败，已用备用模型 ${target.model} 完成压缩。`
          };
          // Remembered for the caller's `noteModelTarget` call: it runs after the
          // transaction commits, by which point only the surviving model is in the
          // result, so the fact that a fallback happened would otherwise be lost.
          this.lastFallback = {
            used: true,
            failedProvider: targets[0].provider,
            failedModel: targets[0].model
          };
        }
        return result;
      } catch (error) {
        // A user cancellation is final; a fallback would contradict the request.
        if (options.signal?.aborted) throw error;
        lastError = error;
        const remaining = targets.length - index - 1;
        if (remaining > 0) {
          const next = targets[index + 1];
          this.job(agent).view = {
            ...this.job(agent).view,
            message: `模型 ${target.model} 压缩失败，改用备用模型 ${next.model}…`
          };
        }
      }
    }
    throw lastError;
  }

  direct(config = this.settings.get()) {
    return config.enabled && config.mode === "direct";
  }

  current(agent) {
    const routed = this.routes?.resolve(agent);
    if (routed) return routed.context;
    const projection = this.ctx.sessionProjections.stateOf(agent.session, "modelSelection");
    const target = projection?.pending ?? projection?.lastUsed ?? agent.session.requestHeader()?.config ?? agent.options;
    return target?.provider && target.model
      ? { provider: target.provider, model: target.model, ...(target.reasoningEffort ? { reasoningEffort: String(target.reasoningEffort) } : {}) }
      : undefined;
  }

  state(id) {
    const agent = id ? this.ctx.agents.get(SessionId(id)) : undefined;
    let available = false;
    if (agent) {
      try {
        this.binding(agent);
        available = true;
      } catch {}
    }
    return {
      config: this.settings.get(),
      available,
      engine: this.chooseFor(this.settings.get()),
      job: {
        ...(agent ? this.job(agent).view : inactive().view),
        ...(agent && this.current(agent) ? { current: this.current(agent) } : {})
      }
    };
  }

  async context(id) {
    const agent = id ? this.ctx.agents.get(SessionId(id)) : undefined;
    if (!agent) return;
    const target = this.current(agent);
    try {
      const value = await this.pressure.refresh(agent.session, target);
      return JSON.stringify(target) === JSON.stringify(this.current(agent)) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Queue one manual compaction.
   *
   * `mode` is one of:
   * - `"configured"` — the model configured for compaction (the first button).
   * - `"current"` — this run only, use the conversation's own model.
   * - `"mechanical"` — the second button: local fold, no model, no tokens.
   * - `"cancel"` — abort the queued or running job.
   */
  request(id, mode) {
    const agent = this.ctx.agents.get(SessionId(id));
    if (!agent) throw new Error("请先打开目标会话。");
    const job = this.job(agent);
    if (mode === "cancel") {
      job.blocked = false;
      job.pending = undefined;
      job.pendingRoute = undefined;
      job.pendingMechanical = false;
      job.abort?.abort(new Error("用户取消压缩。"));
      if (!job.abort) job.view = { phase: "idle", message: "已取消压缩。", failures: job.view.failures };
      return this.state(id);
    }
    if (job.pending || job.pendingMechanical || job.abort) throw new Error("该会话已有压缩任务。");
    this.binding(agent);
    const config = this.settings.get();

    if (mode !== "mechanical") {
      const chosen = this.chooseFor(config);
      if (chosen === "saviour") {
        const route = this.routes?.resolve(agent);
        const target = route?.target ?? (mode === "current" ? this.current(agent) : this.configured(config));
        if (!target?.provider || !target.model) throw new Error("请先在设置中选择压缩模型。");
        job.pending = target;
        job.pendingRoute = route;
        job.pendingMechanical = false;
      } else {
        // The first button follows the engine setting, so with `ledger` selected
        // it must fold rather than reach for a model the user did not choose.
        job.pending = undefined;
        job.pendingRoute = undefined;
        job.pendingMechanical = { replaced: config.replaceDefault };
      }
    } else {
      job.pending = undefined;
      job.pendingRoute = undefined;
      job.pendingMechanical = { replaced: false };
    }
    job.blocked = false;
    job.view = {
      phase: "queued",
      message: agent.status === "idle"
        ? (job.pendingMechanical ? "正在准备机械折页…" : "正在准备压缩…")
        : "已排队，当前模型或工具步骤结束后压缩。",
      failures: job.view.failures
    };
    if (agent.status === "idle") queueMicrotask(() => { void this.runIdle(agent); });
    return this.state(id);
  }

  async runIdle(agent) {
    const job = this.job(agent);
    if ((!job.pending && !job.pendingMechanical) || this.disposed) return;
    try {
      await agent.runMaintenance((signal) => this.runPending(agent, signal, true));
    } catch (error) {
      // A turn may win admission between the click and maintenance. Keep it queued for pre-step.
      if (agent.status !== "idle") return;
      job.pending = undefined;
      job.pendingRoute = undefined;
      job.pendingMechanical = false;
      this.fail(job, error);
    }
  }

  async runPending(agent, signal, idle) {
    const job = this.job(agent);
    const target = job.pending;
    const route = job.pendingRoute;
    const mechanical = job.pendingMechanical;
    if ((!target && !mechanical) || this.disposed) return;
    job.pending = undefined;
    job.pendingRoute = undefined;
    job.pendingMechanical = false;
    try {
      if (mechanical) await this.mechanical(agent, signal, undefined, { owner: idle ? null : "current-turn", replaced: mechanical.replaced });
      else await this.rescue(agent, this.binding(agent), target, signal, idle, undefined, undefined, route);
    } catch (error) {
      if (!signal.aborted && job.view.phase === "queued") this.fail(job, error);
    }
  }

  fail(job, error) {
    job.blocked = true;
    job.view = { ...job.view, phase: "failed", message: errorChain(error) };
  }

  /**
   * Run the mechanical fold as a real compaction transaction.
   *
   * The replacement is `compactSurfaceRegion`, so the log gets the same marker
   * triple, surface-op shape and stability checks as the model path — a folded
   * session stays readable by history, undo and everything else. Only the
   * summarizer differs: `foldSummary` builds the card from the replayed messages
   * with no network call.
   *
   * @param options.owner - `null` for an idle session, `"current-turn"` inside a turn.
   * @param options.range - fixed span (automatic path); omit to select the whole compactable range.
   * @param options.replaced - counted as a `replaceDefault` fold rather than a manual one.
   */
  async mechanical(agent, outerSignal, sourceCommandId, options = {}) {
    const job = this.job(agent);
    if (job.abort) throw new Error("该会话已有压缩任务。");
    const abort = new AbortController();
    job.abort = abort;
    const signal = AbortSignal.any([outerSignal, abort.signal]);
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const binding = this.binding(agent);
        const meter = binding.ctx.tokenMeter;
        const header = agent.session.requestHeader();
        const before = meter.measure(agent.session);
        // Match the model path's fixed-overhead accounting so the two report
        // comparable before/after numbers on the same footer.
        const tools = header?.tools;
        const fixed = tools?.length ? Math.ceil(JSON.stringify(tools).length / 4) + 4 : 0;
        const beforeTokens = fixed + before.surfaceTokens;
        job.view = { phase: "running", message: "正在机械折页…", failures: job.view.failures, beforeTokens };
        // A zero retained tail is the point of a fold: replace every compactable
        // node with the card. `selectCompactableRange` still keeps tool pairs balanced.
        const range = options.range ?? selectCompactableRange(agent.session, before, 0);
        if (!range) throw new Error("可安全折叠的历史不足，已保留最近消息。");
        const result = await compactSurfaceRegion({
          meter,
          summarize: async (input) => foldSummary(input),
          recover: (error, ownerAgent, sourceEventSeqs, abortSignal) => binding.ctx.waterfall("compaction/summary-error", {
            session: ownerAgent.session,
            sourceEventSeqs,
            error,
            ...(abortSignal === undefined ? {} : { signal: abortSignal })
          }, () => false)
        }, agent.session, range.start, range.end, agent, {
          owner: options.owner ?? null,
          stability: options.owner === "current-turn" ? "whole-surface" : "selected-span",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          ...(options.owner === null ? { flush: async () => { await binding.ctx.sessions.flush(agent.session); } } : {})
        }, signal);
        job.blocked = false;
        job.view = {
          phase: "done",
          message: formatFoldNotice(result).split("\n")[0],
          failures: 0,
          beforeTokens,
          afterTokens: fixed + meter.measure(agent.session).surfaceTokens
        };
        noteFold(options.replaced ? "replaced" : "manual");
        return result;
      } catch (error) {
        if (signal.aborted) job.view = { ...job.view, phase: "idle", message: "折页已取消，未完成的卡片不会写入。" };
        else this.fail(job, error);
        throw error;
      } finally {
        job.abort = undefined;
        job.work = undefined;
      }
    })();
    job.work = work;
    return work;
  }

  /**
   * Run the model summarizer over the compactable range.
   *
   * Unchanged from dsh-compact-saviour: it prices the request against a window it
   * resolves, so a small conversation model can be compacted by a large helper,
   * and it refuses to start when the fixed overhead alone overflows.
   */
  async rescue(agent, binding, target, outerSignal, idle, selected, sourceCommandId, lease) {
    const job = this.job(agent);
    if (job.abort) throw new Error("该会话已有压缩任务。");
    const abort = new AbortController();
    job.abort = abort;
    let signal = AbortSignal.any([outerSignal, abort.signal]);
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const route = lease ?? this.routes?.resolve(agent);
        if (route) signal = AbortSignal.any([signal, route.signal]);
        route?.assertCurrent();
        target = route?.target ?? target;
        if (!target?.provider || !target.model) throw new Error("请先在设置 → 压缩管理 中选择压缩模型。");
        const meter = binding.ctx.tokenMeter;
        const current = route?.context ?? this.current(agent);
        const header = agent.session.requestHeader();
        // Reprice retained images for the model selected for the next request.
        const effectiveHeader = header && current ? { ...header, config: { ...header.config, provider: current.provider, model: current.model } } : header;
        const before = meter.measure(agent.session, effectiveHeader);
        // Provider usage is a calibration anchor, not a measurement of immutable
        // overhead. Price the actual tool schemas instead, matching token-meter.
        const tools = effectiveHeader?.tools;
        const fixed = tools?.length ? Math.ceil(JSON.stringify(tools).length / 4) + 4 : 0;
        const beforeTokens = fixed + before.surfaceTokens;
        job.view = { phase: "running", message: "正在压缩上下文…", failures: job.view.failures, beforeTokens };
        const info = current ? await binding.ctx.llm.resolveModelInfo(current.provider, current.model, signal) : undefined;
        signal.throwIfAborted();
        route?.assertCurrent();
        if (info && (info.provider !== current?.provider || info.id !== current.model)) throw new Error("上下文模型元数据与实际路由不一致。");
        const contextWindow = info?.context?.contextWindow;
        if (!contextWindow) throw new Error("当前对话模型没有可确认的上下文容量。");
        const room = Math.floor(contextWindow * 0.75) - fixed - (effectiveHeader?.config.maxTokens ?? info?.defaultMaxTokens ?? 8192);
        if (room < 4000) throw new Error("系统提示词、工具定义和输出预留已占满目标模型空间，仅压缩消息无法容纳；请减少工具或选择更大上下文模型。");
        const retain = Math.min(12000, Math.floor(room * 0.3), Math.floor(before.surfaceTokens * 0.2));
        const range = selected ?? selectCompactableRange(agent.session, before, retain);
        if (!range) throw new Error("可安全压缩的历史不足，已保留最近消息。");
        const from = before.nodes.findIndex((node) => node.seq === range.start);
        const to = before.nodes.findIndex((node) => node.seq === range.end);
        const untouched = before.nodes.reduce((sum, node, index) => sum + (index < from || index > to ? node.tokens : 0), 0);
        const maxSummaryTokens = Math.floor(room - untouched - 1000);
        if (maxSummaryTokens < 1500) throw new Error("保留的最新消息、系统提示和工具已超出目标模型预算；请减少工具或选择更大上下文模型。");
        const summaryBudget = Math.min(6000, maxSummaryTokens);
        const result = await compactSurfaceRegion({
          meter,
          summarize: (input, owner, abortSignal) => this.compressWithFallback(binding.ctx, input, owner, {
            targets: this.targetCandidates(target, route),
            signal: abortSignal ?? signal,
            summaryBudget,
            maxSummaryTokens,
            routeLease: route,
            progress: (completed, total, message) => {
              job.view = { ...job.view, completed, total, message: message ?? (total === 1 ? "正在生成摘要…" : `正在分块压缩 ${completed}/${total}…`) };
            }
          }),
          recover: (error, ownerAgent, sourceEventSeqs, abortSignal) => binding.ctx.waterfall("compaction/summary-error", {
            session: ownerAgent.session,
            sourceEventSeqs,
            error,
            ...(abortSignal === undefined ? {} : { signal: abortSignal })
          }, () => false)
        }, agent.session, range.start, range.end, agent, {
          owner: idle ? null : "current-turn",
          stability: idle ? "selected-span" : "whole-surface",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          ...(idle ? { flush: async () => { await binding.ctx.sessions.flush(agent.session); } } : {})
        }, signal);
        job.blocked = false;
        job.view = {
          phase: "done",
          message: "压缩完成（按当前消息和工具估算）。",
          failures: 0,
          beforeTokens,
          afterTokens: fixed + meter.measure(agent.session, effectiveHeader).surfaceTokens
        };
        noteModel(job.view.beforeTokens, job.view.afterTokens);
        // The committed result names the model that actually produced the summary.
        // On a fallback run that is model 2, which is exactly what the pane needs to
        // show — reading it back off the settings would report model 1 and hide the
        // fallback entirely.
        noteModelTarget({
          provider: result?.provider ?? target?.provider,
          model: result?.model ?? target?.model,
          reasoningEffort: result?.reasoningEffort ?? target?.reasoningEffort,
          fellBack: Boolean(this.lastFallback?.used),
          failedProvider: this.lastFallback?.failedProvider,
          failedModel: this.lastFallback?.failedModel
        });
        this.lastFallback = undefined;
        return result;
      } catch (error) {
        // A cancelled run is not a failure: the user asked for it, and counting it
        // would make the pane's failure count depend on how often someone clicked
        // cancel. Only a run that genuinely broke is recorded.
        if (signal.aborted) job.view = { ...job.view, phase: "idle", message: "压缩已取消，未完成的摘要不会写入。" };
        else {
          this.fail(job, error);
          noteModelFailure();
        }
        throw error;
      } finally {
        job.abort = undefined;
        job.work = undefined;
      }
    })();
    job.work = work;
    return work;
  }

  /** Fold counters plus the live engine count, for the diagnostics pane. */
  foldStats() {
    return { live: this.bindings.size, ...hookStats() };
  }
}

export { formatTokenCount };
