/**
 * One Config schema for the whole plugin.
 *
 * Two subsystems contribute fields: the model path owns the compaction model
 * and its rescue policy, the mechanical path owns the ingress shaper and the
 * fold. They share one object because a Cordis plugin gets exactly one Config
 * schema, and the settings page renders that schema's fields.
 *
 * Field order is the order the settings page shows them, and it groups
 * the two halves: saviour model first (what most users open the page for),
 * then ingress shaping, then the mechanical fold.
 */

import z from "@deepseek-ai/schemastery";
import { buildObjectEnvelope } from "./ledger/schema-envelope.js";

export const PACKAGE = "dsh-compact-manager";
export const SERVICE = "compactManager";
export const NS = PACKAGE;
/** Kept in sync with package.json and the top CHANGELOG entry by a test. */
export const VERSION = "1.0.0";

export const DEFAULTS = {
  // --- saviour (model) half -------------------------------------------------
  enabled: true,
  mode: "rescue",
  provider: "",
  model: "",
  reasoningEffort: "",
  // --- fallback model -------------------------------------------------------
  // Model 2 is tried when model 1 fails. Empty by default, which means "no
  // fallback" — the plugin must never invent a second target the user did not pick.
  fallbackProvider: "",
  fallbackModel: "",
  fallbackReasoningEffort: "",
  // How many official attempts before the rescue path takes over, in `rescue`
  // mode. compaction-basic retries once itself, so 2 matches its own behaviour.
  rescueAfterFailures: 2,
  // --- automatic trigger ----------------------------------------------------
  // These three reproduce compaction-basic's own defaults exactly, so turning the
  // override on changes nothing until a value is edited. They live here rather
  // than being read off the engine because the engine's config is frozen at
  // construction and cannot be edited from a settings page.
  thresholdOverride: true,
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  // --- ledger (mechanical) half ---------------------------------------------
  ingress: true,
  snapImages: false,
  imagePixelBudget: 640000,
  minSnapTokens: 3000,
  savingsRatio: 0.85,
  confirmFold: true,
  replaceDefault: false,
  engine: "auto"
};

/** Engine choices accepted by `/fast-compact` and the `engine` setting. */
export const ENGINES = ["auto", "ledger", "saviour"];
export const MODES = ["rescue", "direct"];

function bool(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

function intInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function ratio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0.05) return 0.05;
  if (n > 1) return 1;
  return n;
}

/**
 * Clamp the trigger ratio.
 *
 * The floor is 10%, not 0: a trigger under that fires before the conversation has
 * accumulated anything worth compacting, and the summarizer would be asked to
 * condense a region it cannot shrink. The ceiling is 95%, leaving room for the
 * output reservation — a 100% trigger can never fire before the window overflows.
 */
function clampRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.95, Math.max(0.1, n));
}

/**
 * Clamp the retained-tail ratio.
 *
 * Kept well under the trigger ratio: `validateRatioRetention` rejects a plugin
 * whose retain ratio reaches its threshold, because the retained tail would then
 * cover the whole compactable region and every compaction would find nothing it
 * is allowed to replace.
 */
function clampRetain(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.5, Math.max(0.02, n));
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/**
 * Normalize a raw settings value into the full shape.
 *
 * `ingress` used to be the ledger plugin's only switch and it wrote a legacy
 * `enabled` key of its own; the merged schema owns `enabled` for the saviour
 * policy, so a stored ledger-era `enabled` cannot be told apart from a saviour
 * one. The migration in `index.js` moves the old entries into this namespace
 * before the first read, and this normalizer treats an absent `ingress` as on.
 */
export function settingsSchema(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    mode: MODES.includes(source.mode) ? source.mode : DEFAULTS.mode,
    provider: text(source.provider),
    model: text(source.model),
    reasoningEffort: text(source.reasoningEffort),
    fallbackProvider: text(source.fallbackProvider),
    fallbackModel: text(source.fallbackModel),
    fallbackReasoningEffort: text(source.fallbackReasoningEffort),
    rescueAfterFailures: intInRange(source.rescueAfterFailures, 1, 5, DEFAULTS.rescueAfterFailures),
    thresholdOverride: bool(source.thresholdOverride, DEFAULTS.thresholdOverride),
    thresholdRatio: clampRatio(source.thresholdRatio, DEFAULTS.thresholdRatio),
    headroomTokens: intInRange(source.headroomTokens, 0, 400000, DEFAULTS.headroomTokens),
    retainRatio: clampRetain(source.retainRatio, DEFAULTS.retainRatio),
    ingress: bool(source.ingress, DEFAULTS.ingress),
    snapImages: bool(source.snapImages, DEFAULTS.snapImages),
    imagePixelBudget: intInRange(source.imagePixelBudget, 200000, 4000000, DEFAULTS.imagePixelBudget),
    minSnapTokens: intInRange(source.minSnapTokens, 200, 200000, DEFAULTS.minSnapTokens),
    savingsRatio: ratio(source.savingsRatio, DEFAULTS.savingsRatio),
    confirmFold: bool(source.confirmFold, DEFAULTS.confirmFold),
    replaceDefault: bool(source.replaceDefault, DEFAULTS.replaceDefault),
    engine: ENGINES.includes(source.engine) ? source.engine : DEFAULTS.engine
  };
}

/** Field table shared by the schema and its canonical wire envelope. */
export const FIELDS = {
  enabled: { type: "boolean", meta: { default: DEFAULTS.enabled } },
  mode: { type: "string", meta: { default: DEFAULTS.mode } },
  provider: { type: "string", meta: { default: DEFAULTS.provider } },
  model: { type: "string", meta: { default: DEFAULTS.model } },
  reasoningEffort: { type: "string", meta: { default: DEFAULTS.reasoningEffort } },
  fallbackProvider: { type: "string", meta: { default: DEFAULTS.fallbackProvider } },
  fallbackModel: { type: "string", meta: { default: DEFAULTS.fallbackModel } },
  fallbackReasoningEffort: { type: "string", meta: { default: DEFAULTS.fallbackReasoningEffort } },
  rescueAfterFailures: { type: "number", meta: { step: 1, min: 1, max: 5, default: DEFAULTS.rescueAfterFailures } },
  thresholdOverride: { type: "boolean", meta: { default: DEFAULTS.thresholdOverride } },
  thresholdRatio: { type: "number", meta: { min: 0.1, max: 0.95, default: DEFAULTS.thresholdRatio } },
  headroomTokens: { type: "number", meta: { step: 1024, min: 0, max: 400000, default: DEFAULTS.headroomTokens } },
  retainRatio: { type: "number", meta: { min: 0.02, max: 0.5, default: DEFAULTS.retainRatio } },
  ingress: { type: "boolean", meta: { default: DEFAULTS.ingress } },
  snapImages: { type: "boolean", meta: { default: DEFAULTS.snapImages } },
  imagePixelBudget: { type: "number", meta: { step: 1000, min: 200000, max: 4000000, default: DEFAULTS.imagePixelBudget } },
  minSnapTokens: { type: "number", meta: { step: 1, min: 200, max: 200000, default: DEFAULTS.minSnapTokens } },
  savingsRatio: { type: "number", meta: { min: 0.05, max: 1, default: DEFAULTS.savingsRatio } },
  confirmFold: { type: "boolean", meta: { default: DEFAULTS.confirmFold } },
  replaceDefault: { type: "boolean", meta: { default: DEFAULTS.replaceDefault } },
  engine: { type: "string", meta: { default: DEFAULTS.engine } }
};

/**
 * Canonical `{ uid, refs }` envelope. The browser settings form reads the
 * Host-projected schema through `configForms`, but the diagnostics pane and the
 * tests compare against this envelope, so it stays published.
 */
settingsSchema.toJSON = () => buildObjectEnvelope(FIELDS);

/**
 * The live Config schema.
 *
 * Every field is `.volatile()` because that is the only kind the settings form
 * writes back, and the page edits all of them. `settings.register(ns,
 * schema)` no longer exists on this harness line; the resolved Config instance
 * arrives as `apply(ctx, config)` and `settings.update(ns, patch)` persists.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile()
    .description("启用自动压缩辅助：官方连续失败两次后由 Saviour 模型救援"),
  mode: z.union(MODES).default(DEFAULTS.mode).volatile()
    .description("rescue：官方失败两次后救援；direct：自动压缩直接用 Saviour 模型"),
  provider: z.string().default(DEFAULTS.provider).volatile()
    .description("Saviour 压缩模型的 provider"),
  model: z.string().default(DEFAULTS.model).volatile()
    .description("Saviour 压缩模型"),
  reasoningEffort: z.string().default(DEFAULTS.reasoningEffort).volatile()
    .description("Saviour 压缩模型的 reasoning level"),
  fallbackProvider: z.string().default(DEFAULTS.fallbackProvider).volatile()
    .description("模型 1 压缩失败时改用的备用 provider；留空表示不启用备用模型"),
  fallbackModel: z.string().default(DEFAULTS.fallbackModel).volatile()
    .description("模型 1 压缩失败时改用的备用模型；留空表示不启用备用模型"),
  fallbackReasoningEffort: z.string().default(DEFAULTS.fallbackReasoningEffort).volatile()
    .description("备用模型的 reasoning level"),
  rescueAfterFailures: z.number().min(1).max(5).step(1)
    .default(DEFAULTS.rescueAfterFailures).volatile()
    .description("rescue 模式下官方压缩连续失败几次后交给 Saviour；direct 模式不使用"),
  thresholdOverride: z.boolean().default(DEFAULTS.thresholdOverride).volatile()
    .description("用本页的触发参数覆盖官方自动压缩阈值；关闭则沿用 compaction-basic 自带配置"),
  thresholdRatio: z.number().min(0.1).max(0.95).step(0.01)
    .default(DEFAULTS.thresholdRatio).volatile()
    .description("自动压缩触发线：上下文用到窗口的这个比例就压缩。headroom 更紧时以 headroom 为准"),
  headroomTokens: z.number().min(0).max(400000).step(1024)
    .default(DEFAULTS.headroomTokens).volatile()
    .description("预留空间：必须留在窗口里不用的绝对 token 数，小窗口时它比触发线更早生效"),
  retainRatio: z.number().min(0.02).max(0.5).step(0.01)
    .default(DEFAULTS.retainRatio).volatile()
    .description("压缩后逐字保留的最近原文比例，按消息预算算；必须明显小于触发线"),
  ingress: z.boolean().default(DEFAULTS.ingress).volatile()
    .description("入境定形：只裁当前回合紧邻上一步、还没发送的大 tool_result"),
  snapImages: z.boolean().default(DEFAULTS.snapImages).volatile()
    .description("主模型 inputModalities 含 image 时，把头段渲染成密排 PNG"),
  imagePixelBudget: z.number().min(200000).max(4000000).step(1000)
    .default(DEFAULTS.imagePixelBudget).volatile()
    .description("传图像素预算，必须与 llm-deepseek 的 imagePixelBudget 一致"),
  minSnapTokens: z.number().min(200).max(200000).step(1)
    .default(DEFAULTS.minSnapTokens).volatile()
    .description("超过这个估算 token 量才摘录或贴图"),
  savingsRatio: z.number().min(0.05).max(1).step(0.01)
    .default(DEFAULTS.savingsRatio).volatile()
    .description("摘录 + 估图 token ≤ 原文的这个比例，才贴 PNG"),
  confirmFold: z.boolean().default(DEFAULTS.confirmFold).volatile()
    .description("手动机械压缩按钮要再点一次确认才折页"),
  replaceDefault: z.boolean().default(DEFAULTS.replaceDefault).volatile()
    .description("/compact、自动压缩、溢出恢复都改走机械折页，不再调模型"),
  engine: z.string().default(DEFAULTS.engine).volatile()
    .description("不带参数的 /fast-compact 用哪个压缩引擎：auto 按可用性、ledger 机械折页、saviour 交回专用模型")
});
