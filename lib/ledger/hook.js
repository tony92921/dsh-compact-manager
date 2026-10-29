/**
 * Compaction counters for diagnostics.
 *
 * Before the merge this module installed the mechanical summarizer itself by
 * patching `engine.summarize` on every engine it could find, then tracked
 * `WeakRef`s to those engines so the diagnostics pane could report how many were
 * still alive. All of that is gone: the merged Controller owns
 * `compactRegion` / `compactIfNeeded` / `compactNow` and calls `foldSummary`
 * directly, so a second hook on `summarize` would be unreachable code that also
 * made `/fast-compact status` report an engine count nobody could act on. The
 * live-engine count now comes from the Controller's own binding map.
 *
 * What survives is the part with lasting value: counting what each strategy did.
 *
 * Two properties the diagnostics pane depends on, and that a future change must
 * not break silently:
 *
 * - **Both strategies are counted.** An earlier revision only counted folds,
 *   which made the pane claim the model path never ran. `noteModel` exists so
 *   that the two halves of the plugin are equally visible.
 * - **Manual and `replaceDefault` folds stay separate.** They used to be summed
 *   into one cell, which hid whether `replaceDefault` had ever taken over an
 *   automatic path — the one thing that setting is judged by.
 *
 * The counters are process-scoped and in-memory: they start at zero on every
 * Host start and are shared by every session this process serves, which is what
 * the pane's group heading says.
 */

const stats = {
  mechanicalFolds: 0,
  replacedFolds: 0,
  modelCompactions: 0,
  modelFailures: 0,
  modelSavedTokens: 0,
  lastModelBefore: 0,
  lastModelAfter: 0,
  // Which model produced the last successful summary, and when. Kept as strings
  // because this is a process-wide counter block shared by every session: recording
  // "the last one that ran" answers "did the fallback fire?" without needing a
  // per-session table.
  lastModelProvider: "",
  lastModelId: "",
  lastModelEffort: "",
  lastModelAt: 0,
  // Set when model 1 failed and model 2 finished the job. Without this the pane
  // would show only the surviving model and hide that a fallback happened.
  lastModelFellBack: false,
  lastModelFailedProvider: "",
  lastModelFailedId: ""
};

/**
 * Record one completed fold.
 *
 * @param kind - `"manual"` for a user-requested fold, `"replaced"` when
 *   `replaceDefault` took over a path that would otherwise have called a model.
 *   Anything else is ignored: the counters feed a diagnostics pane, and an
 *   unrecognised label there would be a number nobody can interpret.
 */
export function noteFold(kind) {
  if (kind === "replaced") stats.replacedFolds += 1;
  else if (kind === "manual") stats.mechanicalFolds += 1;
}

/**
 * Record one successful model compaction with its before/after measurements.
 *
 * `saved = before - after` is accumulated from the two absolute numbers rather
 * than passed in, so the pane's "saved" total and its "last run" line can never
 * disagree. Clamped at zero because a summarizer can hand back a card longer than
 * the region it replaced on a very short span, and a negative saving reads as a
 * bug rather than as a small region.
 *
 * @param beforeTokens - request estimate before the run.
 * @param afterTokens - request estimate after the run.
 */
export function noteModel(beforeTokens, afterTokens) {
  const before = Math.max(0, Math.round(Number(beforeTokens) || 0));
  const after = Math.max(0, Math.round(Number(afterTokens) || 0));
  stats.modelCompactions += 1;
  stats.modelSavedTokens += Math.max(0, before - after);
  stats.lastModelBefore = before;
  stats.lastModelAfter = after;
}

/**
 * Record one failed model compaction.
 *
 * Separate from `noteModel` on purpose: a run that threw never produced an
 * after-token measurement, so folding it into the success counter would make the
 * saved-token total depend on how often the summarizer happened to fail.
 */
export function noteModelFailure() {
  stats.modelFailures += 1;
}

/**
 * Record which model produced one successful summary.
 *
 * Called from `noteModel`'s call site with the model that actually answered, which
 * on a fallback run is model 2, not the configured model 1. The provider/model pair
 * is stored verbatim rather than as one joined string so the pane can render it
 * consistently with the settings page.
 *
 * @param info - `{ provider, model, reasoningEffort?, fellBack?, failedProvider?, failedModel? }`.
 */
export function noteModelTarget(info = {}) {
  stats.lastModelProvider = String(info.provider ?? "");
  stats.lastModelId = String(info.model ?? "");
  stats.lastModelEffort = String(info.reasoningEffort ?? "");
  stats.lastModelAt = Date.now();
  stats.lastModelFellBack = info.fellBack === true;
  stats.lastModelFailedProvider = String(info.failedProvider ?? "");
  stats.lastModelFailedId = String(info.failedModel ?? "");
}

/** Snapshot of every counter. */
export function hookStats() {
  return {
    mechanicalFolds: stats.mechanicalFolds,
    replacedFolds: stats.replacedFolds,
    modelCompactions: stats.modelCompactions,
    modelFailures: stats.modelFailures,
    modelSavedTokens: stats.modelSavedTokens,
    lastModelBefore: stats.lastModelBefore,
    lastModelAfter: stats.lastModelAfter,
    lastModelProvider: stats.lastModelProvider,
    lastModelId: stats.lastModelId,
    lastModelEffort: stats.lastModelEffort,
    lastModelAt: stats.lastModelAt,
    lastModelFellBack: stats.lastModelFellBack,
    lastModelFailedProvider: stats.lastModelFailedProvider,
    lastModelFailedId: stats.lastModelFailedId
  };
}

/** Test seam: reset the counters. */
export function resetFoldStats() {
  for (const key of Object.keys(stats)) {
    // Reset by type: numbers to zero, strings to empty, so the snapshot keeps a
    // stable shape across tests that assert on it.
    stats[key] = typeof stats[key] === "boolean" ? false : typeof stats[key] === "string" ? "" : 0;
  }
}
