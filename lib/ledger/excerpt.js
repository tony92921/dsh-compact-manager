/** Ingress excerpt: head/tail slice with a re-read contract. Never mutates later. */

import { clampUtf8 } from "./tokens.js";

export const SNAP_HEAD_LINES = 16;
export const SNAP_TAIL_LINES = 8;
export const SNAP_EXCERPT_MAX = 2400;

export const PLACEHOLDER_PREFIXES = [
  "[Output truncated",
  "[Superseded",
  "[Artifact stored",
  "[Shake elided",
  "[Snapcompact",
  "[Ledger]",
  "[Uneventful",
  "[image omitted",
  "[... tool result middle pruned"
];

export function isPlaceholder(text) {
  const value = String(text ?? "").trimStart();
  return PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p));
}

export function skipIngressTool(name) {
  const tool = String(name ?? "");
  return tool === "skill" || tool === "context";
}

export function snapExcerpt(text, options = {}) {
  const head = options.headLines ?? SNAP_HEAD_LINES;
  const tail = options.tailLines ?? SNAP_TAIL_LINES;
  const maxBytes = options.maxBytes ?? SNAP_EXCERPT_MAX;
  const value = String(text ?? "");
  const lines = value.split("\n");
  let body;
  if (lines.length <= head + tail) body = value;
  else {
    const skipped = lines.length - head - tail;
    body = lines.slice(0, head).join("\n")
      + "\n… (" + skipped + " lines elided; see image if attached. To inspect or edit exact bytes, re-read with offset/limit) …\n"
      + lines.slice(-tail).join("\n");
  }
  return clampUtf8(body, maxBytes);
}

/** A token longer than this is structure (a path, a timestamp), not a value. */
const DIGEST_MAX_TOKEN = 16;
/** A token has to repeat this often before a count question can be about it. */
const DIGEST_MIN_COUNT = 3;
const DIGEST_TOP = 8;

/**
 * Mechanical whole-file totals — the values a "how many X are in this file" question is
 * about, counted for free in text. Neither a picture nor a head/tail excerpt can count a
 * 2000-line file, and the model cannot count it either; measured paired over 168
 * questions, this line takes that class from 35% to 78% structure accuracy and leaves
 * exact-value reading untouched (bench/FINDINGS.md, `excerpt-digest`).
 */
export function tokenDigest(text, options = {}) {
  const top = options.top ?? DIGEST_TOP;
  const counts = new Map();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");
    if (!token || token.length > DIGEST_MAX_TOKEN) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const rows = [...counts]
    .filter(([, n]) => n >= DIGEST_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top);
  return rows.length === 0 ? "" : "whole-file totals: " + rows.map(([t, n]) => t + "×" + n).join(" · ");
}

export function excerptNotice(originalTokens, excerpt, extra = "", digest = "") {
  const head = extra
    ? "[Snapcompact: " + originalTokens + " tokens → " + extra + "]"
    : "[Snapcompact: " + originalTokens + " tokens → excerpt]";
  return head + "\n" + excerpt + (digest ? "\n" + digest : "");
}

export function collectText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-result" && Array.isArray(block.content)) parts.push(collectText(block.content));
  }
  return parts.filter(Boolean).join("\n");
}
