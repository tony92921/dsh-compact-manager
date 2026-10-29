/** UTF-8 token heuristic matching pi-moke / pi-zig fast-compress. */

export const MIN_SNAP_TOKENS = 3000;
export const SNAP_SAVINGS = 0.85;
/** An ingress image may not cost more than this share of the text it renders. */
export const IMAGE_ECONOMY = 0.85;
export const HARD_PERCENT = 85;
export const PROACTIVE_PERCENT = 40;
/** When the model window is unknown, fill the bolt over this many foldable tokens. */
export const FILL_SOFT_TOKENS = 32000;

export function estTokensUtf8(text) {
  const value = String(text ?? "");
  let ascii = 0;
  let two = 0;
  let wide = 0;
  for (const ch of value) {
    const n = ch.length === 1 ? (ch.charCodeAt(0) < 0x80 ? 1 : ch.charCodeAt(0) < 0x800 ? 2 : 3) : 4;
    if (n === 1) ascii += 1;
    else if (n === 2) two += 1;
    else wide += 1;
  }
  return Math.floor(ascii / 4) + Math.floor((two * 2) / 3) + wide;
}

export function clampUtf8(text, maxBytes) {
  const value = String(text ?? "");
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, Math.max(0, end)).toString("utf8");
}

export function percentOf(used, window) {
  if (!window || window <= 0) return 0;
  return Math.floor((used * 100) / window);
}

/** Tokens that compactNow would fold: everything except the newest surface node. */
export function compactableTokens(measurement) {
  const nodes = measurement && Array.isArray(measurement.nodes) ? measurement.nodes : [];
  if (nodes.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const node = nodes[i] || {};
    const tok = Number(node.tokens);
    if (Number.isFinite(tok) && tok > 0) {
      total += tok;
      continue;
    }
    const heur = Number(node.heuristicTokens);
    if (Number.isFinite(heur) && heur > 0) total += heur;
  }
  return total;
}

/** 0–1 bolt fill: context pressure when the window is known, else foldable mass. */
export function iconFill(used, window, compactable) {
  const u = Number(used);
  const w = Number(window);
  const c = Number(compactable);
  const usedN = Number.isFinite(u) && u > 0 ? u : 0;
  const windowN = Number.isFinite(w) && w > 0 ? w : 0;
  const compactN = Number.isFinite(c) && c > 0 ? c : 0;
  if (windowN > 0) return Math.min(1, Math.max(0, usedN / windowN));
  if (compactN <= 0) return 0;
  return Math.min(1, compactN / FILL_SOFT_TOKENS);
}
