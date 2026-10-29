/**
 * The automatic-pressure trigger, in one place.
 *
 * compaction-basic decides "is the context full enough to compact" from three
 * numbers, and the useful question is never any single one of them — it is *at
 * which token count does a compaction start, and which limit set it*:
 *
 *     message budget  = window − reserved output
 *     threshold       = min( window × ratio , message budget − headroom )
 *     retained tail   = message budget × retainRatio
 *
 * The two candidates are why the same 80% does not mean the same thing on two
 * models. `headroomTokens` is an absolute number (65536 by default), so on a large
 * window the ratio always wins, while on a small window headroom cuts in first:
 *
 * | window     | threshold        |
 * |------------|------------------|
 * | 1,000,000  | 800,000  (80%)   |
 * | 200,000    | 101,696  (50.8%) |
 * | 131,072    | 32,768   (25%)   |
 *
 * That table is the reason this module returns `cappedBy` rather than a bare
 * number: a trigger that fires at 25% is not a bug, but it is unreadable without
 * knowing that the fixed headroom, not the ratio, decided it.
 *
 * This function is the single implementation. The Host enforces it when the
 * plugin takes over the trigger, and the settings page renders it from the same
 * code over HTTP rather than recomputing a display copy that could drift.
 */

/** Bounds the Config schema and the settings form both use. */
export const LIMITS = {
  ratio: { min: 0.1, max: 0.95 },
  headroom: { min: 0, max: 400000 },
  retain: { min: 0.02, max: 0.5 }
};

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Price one automatic-compaction trigger.
 *
 * @param contextWindow - the conversation model's capacity, in tokens.
 * @param reservedTokens - output tokens the routed request reserves.
 * @param settings - `{ thresholdRatio, headroomTokens, retainRatio }`.
 * @returns A resolved spec. `known: false` with a `reason` means the inputs
 *   cannot produce a trigger at all — a missing window, or a headroom that eats
 *   the whole budget, which is a configuration error the caller must surface
 *   instead of silently never compacting.
 */
export function resolveThreshold(contextWindow, reservedTokens, settings = {}) {
  const window = Number(contextWindow);
  const reserved = Math.max(0, Math.round(Number(reservedTokens) || 0));
  const ratio = clamp(settings.thresholdRatio, LIMITS.ratio.min, LIMITS.ratio.max, 0.8);
  const headroom = Math.round(clamp(settings.headroomTokens, LIMITS.headroom.min, LIMITS.headroom.max, 65536));
  const retainRatio = clamp(settings.retainRatio, LIMITS.retain.min, LIMITS.retain.max, 0.16);

  if (!Number.isFinite(window) || window <= 0) {
    return { known: false, reason: "no-window", contextWindow: 0, thresholdRatio: ratio, headroomTokens: headroom, retainRatio };
  }
  const messageBudget = window - reserved;
  if (messageBudget <= 0) {
    return {
      known: false,
      reason: "reserved-over-window",
      contextWindow: window,
      reservedTokens: reserved,
      thresholdRatio: ratio,
      headroomTokens: headroom,
      retainRatio
    };
  }
  const pressureBudget = messageBudget - headroom;
  if (pressureBudget <= 0) {
    return {
      known: false,
      reason: "headroom-over-budget",
      contextWindow: window,
      reservedTokens: reserved,
      messageBudget,
      thresholdRatio: ratio,
      headroomTokens: headroom,
      retainRatio
    };
  }

  const byRatio = Math.floor(window * ratio);
  const byHeadroom = pressureBudget;
  const thresholdTokens = Math.min(byRatio, byHeadroom);
  const cappedBy = byHeadroom < byRatio ? "headroom" : "ratio";
  const thresholdPercent = (thresholdTokens / window) * 100;

  // A retained tail that reaches the threshold would swallow the entire compactable
  // region, and `selectCompactableRange` would then refuse every time — a plugin
  // that looks enabled and never compacts. Clamping keeps the configured ratio as
  // the intent and reports the adjustment instead of silently doing nothing.
  let retainTokens = Math.floor(messageBudget * retainRatio);
  const retainClamped = retainTokens >= thresholdTokens;
  if (retainClamped) retainTokens = Math.floor(thresholdTokens / 2);

  return {
    known: true,
    contextWindow: window,
    reservedTokens: reserved,
    messageBudget,
    headroomTokens: headroom,
    thresholdRatio: ratio,
    retainRatio,
    byRatio,
    byHeadroom,
    thresholdTokens,
    thresholdPercent,
    cappedBy,
    retainTokens,
    retainClamped
  };
}

/** Human-readable explanation of one resolved spec, for the command output. */
export function describeThreshold(spec) {
  if (!spec || spec.known === false) {
    const cause = spec?.reason === "no-window"
      ? "当前模型没有可确认的上下文容量"
      : spec?.reason === "headroom-over-budget"
        ? `预留空间 ${spec.headroomTokens} 已吃满消息预算 ${spec.messageBudget}`
        : spec?.reason === "reserved-over-window"
          ? `输出预留 ${spec.reservedTokens} 已超过窗口 ${spec.contextWindow}`
          : "参数不足";
    return `threshold: 无法计算（${cause}）`;
  }
  const lines = [
    `threshold: ${spec.thresholdTokens} tok（${spec.thresholdPercent.toFixed(1)}% of ${spec.contextWindow}）`
      + ` · 由${spec.cappedBy === "headroom" ? "预留空间" : "触发线比例"}决定`,
    `  min(window ${spec.contextWindow} × ${(spec.thresholdRatio * 100).toFixed(0)}% = ${spec.byRatio},`
      + ` window − 输出预留 ${spec.reservedTokens} − 预留空间 ${spec.headroomTokens} = ${spec.byHeadroom})`,
    `  retain: ${spec.retainTokens} tok（${(spec.retainRatio * 100).toFixed(0)}% of 消息预算 ${spec.messageBudget}）`
      + (spec.retainClamped ? " · 已下调，原比例会让保留段吞掉全部可压区域" : "")
  ];
  return lines.join("\n");
}
