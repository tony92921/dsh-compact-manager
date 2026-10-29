/** Ingress images only when the main model explicitly lists image modalities. */

export function modalitiesIncludeImage(modalities) {
  if (!Array.isArray(modalities)) return undefined;
  return modalities.includes("image");
}

/**
 * Dense PNG rides the main prefix only when the user opted in *and* the
 * adapter advertised image input. Name heuristics (claude/grok/…) never
 * enable snapping — unknown modalities stay excerpt-only.
 */
export function resolveVisionRoute(input = {}) {
  const mainProvider = String(input.mainProvider ?? "").trim();
  const mainModel = String(input.mainModel ?? "").trim();
  const fromModalities = modalitiesIncludeImage(input.inputModalities);
  const snapImages = input.snapImages === true;
  return {
    mainProvider,
    mainModel,
    snapImages,
    ingressVision: snapImages && fromModalities === true
  };
}
