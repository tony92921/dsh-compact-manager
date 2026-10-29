// snapfont.js — OMP 同款密图字库：X.org 8x13 + 16x16 CJK。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CJK_PX = 16;
const PAPER = 245;
const INK = 16;
/** Secondary inks: rules and the line ruler stay readable but recede. */
const RULE = 205;
const GUTTER_INK = 150;

const here = dirname(fileURLToPath(import.meta.url));
const font8 = readFileSync(join(here, "fonts", "font8x13.bin"));
const fontCjk = readFileSync(join(here, "fonts", "snapcjk.bin"));

function u32le(buf, off) {
  return buf.readUInt32LE(off);
}

/**
 * Glyph blobs behind an 8-byte magic: u32le count at 12, count u32le codepoints at
 * 16, then count fixed-size blobs of `ceil(w/8) * h` bytes — one bit row per pixel
 * row, MSB first. The box comes from the header (atlas) or from the caller (CJK).
 */
function loadGlyphs(buf, magic, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const glyphBytes = rowBytes * h;
  const atlas = { w, h, rowBytes, glyphs: new Map() };
  if (buf.length < 16 || buf.subarray(0, magic.length).toString("binary") !== magic) return atlas;
  const count = u32le(buf, 12);
  const cpsOff = 16;
  const bitsOff = cpsOff + count * 4;
  for (let i = 0; i < count; i++) {
    const start = bitsOff + i * glyphBytes;
    if (start + glyphBytes > buf.length) break;
    atlas.glyphs.set(u32le(buf, cpsOff + i * 4), buf.subarray(start, start + glyphBytes));
  }
  return atlas;
}

/** Parse an FGATLAS1 atlas buffer (see tools/make-atlas.py). */
export function parseAsciiAtlas(buffer) {
  const w = buffer.length >= 16 && buffer.subarray(0, 8).toString("binary") === "FGATLAS1" ? buffer[8] : 0;
  const h = w ? buffer[9] : 0;
  return loadGlyphs(buffer, "FGATLAS1", w, h);
}

const defaultAscii = parseAsciiAtlas(font8);
const asciiCjk = loadGlyphs(fontCjk, "SNAPCJK1", CJK_PX, CJK_PX);

/** Test/production seam: render ASCII from an alternative atlas. */
let activeAscii = null;
/** Digits can come from a second atlas (bolder, or a bigger box) at no capacity cost. */
let activeDigits = null;

const asciiAtlas = () => activeAscii ?? defaultAscii;
const digitAtlas = () => activeDigits;

/** Install an atlas from parseAsciiAtlas (or null to restore the shipped one). */
export function setAsciiAtlas(atlas) {
  activeAscii = atlas && atlas.glyphs ? atlas : null;
}

/** Install a digits-only atlas, or null to draw digits from the main one. */
export function setDigitAtlas(atlas) {
  activeDigits = atlas && atlas.glyphs ? atlas : null;
}

export function lookup8(cp) {
  return asciiAtlas().glyphs.get(cp);
}

export function lookupCjk(cp) {
  return asciiCjk.glyphs.get(cp);
}

export function familyOf(model) {
  const n = (model ?? "").toLowerCase();
  if (n.includes("claude") || n.includes("anthropic")) return "anthropic";
  if (n.includes("deepseek")) return "deepseek";
  return "openai";
}

export function resolveShape(model, options = {}) {
  const family = familyOf(model);
  // The cell has to hold whatever glyph box the active atlas declares — otherwise a
  // wider atlas bleeds into the neighbouring cell — and the canvas has to stay inside
  // the request pixel budget. Both follow the atlas, so swapping the font is a data
  // change (lib/fonts/README.md) and never a silent overflow.
  const atlas = asciiAtlas();
  const cellW = Math.max(8, atlas.w);
  const cellH = Math.max(16, atlas.h);
  const cols = Math.floor(1024 / cellW);
  if (family === "anthropic") {
    const acw = Math.max(11, cellW);
    const acols = Math.floor(1562 / acw);
    return { name: "11on16", family, cellW: acw, cellH, cols: acols, frameW: acols * acw, frameH: 1568 };
  }
  if (family === "deepseek") {
    // Drawn inside the request-image pixel budget on purpose. A frame the pipeline has
    // to resize loses its glyph detail to the resample — measured 1–2/10 answers at
    // 1024x2046 against 8/10 for the same content drawn at 1024x624 — while the bill is
    // the same ~430 tokens either way (bench/report.md). cellH 16 was the densest
    // geometry that kept accuracy.
    const budget = Math.max(200000, Number(options.imagePixelBudget) || REQUEST_PIXEL_BUDGET);
    const frameW = cols * cellW;
    const frameH = Math.floor(Math.floor(budget / frameW) / cellH) * cellH;
    return { name: "8on16-budget", family, cellW, cellH, cols, frameW, frameH, pixelBudget: budget };
  }
  // 2048 = four whole 512px tile bands. The bill is per band, so the canvas cap
  // has to land on a band edge — at 1540 the last band bought four usable pixels.
  return { name: "8on22", family, cellW, cellH: Math.max(22, cellH), cols, frameW: cols * cellW, frameH: 2048 };
}

export function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

export function cellsOf(cp) {
  return isWide(cp) ? 2 : 1;
}

/** DeepSeek v4 request-image accounting, fitted against the live API (2026-09-10). */
const DS_BASE = 70;
const DS_RATE = 5.7e-4;
const DS_MIN = 213;
const DS_MAX = 1043;

/**
 * Vision tokens DeepSeek v4 bills for one request image.
 *
 * The published calculator caps an image at 384 tokens, but the live endpoint bills
 * ~213 at the floor and up to ~1043 for a full frame; this is the measured curve
 * (see bench/fidelity-bench.mjs, which reports measured \`usage.prompt_tokens\`).
 */
export function deepseekImageTokens(w, h) {
  const px = Math.max(0, Number(w) || 0) * Math.max(0, Number(h) || 0);
  const raw = Math.round(DS_BASE + px * DS_RATE);
  return Math.max(DS_MIN, Math.min(DS_MAX, raw));
}

/**
 * Billed image tokens.
 *
 * For DeepSeek routes the request pipeline has already resized the frame to the
 * model's pixel budget before the provider sees it (that resize is what the model
 * reads and what the bill is computed from), so the estimate is taken on the
 * preview size, not on the drawn size.
 */
export function previewSize(w, h, family, budget) {
  if (family !== "deepseek") return { width: w, height: h, resized: false, scale: 1 };
  const limit = Math.max(1, Number(budget) || REQUEST_PIXEL_BUDGET);
  const scale = Math.min(1, Math.sqrt(limit / Math.max(1, w * h)));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    resized: scale < 1,
    scale
  };
}

export function estImageTokens(w, h, family, budget) {
  if (family === "deepseek") {
    const preview = previewSize(w, h, family, budget);
    return deepseekImageTokens(preview.width, preview.height);
  }
  if (family === "anthropic") return Math.max(1, Math.ceil((w * h) / 750));
  if (family === "google") return 1120;
  const tiles = Math.max(1, Math.ceil(w / 512) * Math.ceil(h / 512));
  return 85 + 170 * tiles;
}

/** Request-image pixel budget DeepSeek routes resize to before dispatch. */
export const REQUEST_PIXEL_BUDGET = 640000;

export function maxRows(textTok, excerptTok, shape) {
  const keep = Math.floor((textTok * 85) / 100);
  if (keep <= excerptTok) return 0;
  const budget = keep - excerptTok;
  const hard = Math.floor(shape.frameH / shape.cellH);
  if (hard <= 0) return 0;
  let lo = 0;
  let hi = hard;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo + 1) / 2);
    const tok = estImageTokens(shape.frameW, mid * shape.cellH, shape.family, shape.pixelBudget);
    if (tok <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function put(px, stride, x, y, v) {
  if (x < 0 || x >= stride) return;
  const i = y * stride + x;
  if (i < 0 || i >= px.length) return;
  px[i] = v;
}

/** Draw one glyph box centered in the cell; the atlas decides how big that box is. */
function blitGlyph(px, stride, x, y, atlas, bits, shape, ink = INK) {
  const ox = shape.cellW > atlas.w ? Math.floor((shape.cellW - atlas.w) / 2) : 0;
  const oy = shape.cellH > atlas.h ? Math.floor((shape.cellH - atlas.h) / 2) : 0;
  for (let r = 0; r < atlas.h; r++) {
    const base = r * atlas.rowBytes;
    for (let c = 0; c < atlas.w; c++) {
      if (((bits[base + (c >> 3)] >> (7 - (c & 7))) & 1) === 0) continue;
      put(px, stride, x + ox + c, y + oy + r, ink);
    }
  }
}

function blitCjk(px, stride, x, y, bits, shape, ink = INK) {
  blitGlyph(px, stride, x, y, asciiCjk, bits, { cellW: shape.cellW * 2, cellH: shape.cellH }, ink);
}

function blitBox(px, stride, x, y, bw, bh, ink = INK) {
  if (bw < 3 || bh < 3) return;
  for (let c = 1; c + 1 < bw; c++) {
    put(px, stride, x + c, y + 1, ink);
    put(px, stride, x + c, y + bh - 2, ink);
  }
  for (let r = 1; r + 1 < bh; r++) {
    put(px, stride, x + 1, y + r, ink);
    put(px, stride, x + bw - 2, y + r, ink);
  }
}

export function wrapLines(text, cols) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n") {
      rows.push("");
      i += 1;
      continue;
    }
    const start = i;
    let used = 0;
    while (i < text.length && text[i] !== "\n") {
      const cp = text.codePointAt(i) ?? 63;
      const w = cellsOf(cp);
      if (used > 0 && used + w > cols) break;
      used += w;
      i += cp > 0xffff ? 2 : 1;
    }
    rows.push(text.slice(start, i));
    if (text[i] === "\n") i += 1;
  }
  return rows;
}

/** Draw already-wrapped sub-rows into a cell box whose top-left corner is (x, y). */
function drawCells(px, stride, x, y, lines, cols, shape, ink, digitInk) {
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k] ?? "";
    let col = 0;
    let i = 0;
    while (i < line.length) {
      const cp = line.codePointAt(i) ?? 63;
      const wcells = cellsOf(cp);
      if (col + wcells > cols) break;
      const gx = x + col * shape.cellW;
      const gy = y + k * shape.cellH;
      const isDigit = cp >= 0x30 && cp <= 0x39;
      const useInk = digitInk !== undefined && isDigit ? digitInk : ink;
      if (wcells === 2) {
        const bits = lookupCjk(cp);
        if (bits) blitCjk(px, stride, gx, gy, bits, shape, useInk);
        else blitBox(px, stride, gx, gy, shape.cellW * 2, shape.cellH, useInk);
      } else {
        const base = asciiAtlas();
        const atlas = isDigit && digitAtlas() ? digitAtlas() : base;
        const bits = atlas.glyphs.get(cp) ?? base.glyphs.get(cp);
        if (bits) blitGlyph(px, stride, gx, gy, atlas, bits, shape, useInk);
        else blitBox(px, stride, gx, gy, shape.cellW, shape.cellH, useInk);
      }
      col += wcells;
      i += cp > 0xffff ? 2 : 1;
    }
  }
}

/** Single-column raster of a whole text blob (no packing, no ruler). */
export function raster(text, shape, maxRowCount) {
  if (maxRowCount <= 0) return undefined;
  const lines = wrapLines(text, shape.cols);
  if (lines.length === 0) return undefined;
  const rows = Math.min(lines.length, maxRowCount);
  const w = shape.frameW;
  const h = rows * shape.cellH;
  const pixels = new Uint8Array(w * h);
  pixels.fill(PAPER);
  drawCells(pixels, w, 0, 0, lines.slice(0, rows), shape.cols, shape, INK);
  return { pixels, w, h, rows };
}

/**
 * Rasterize a layout plan from layout.js.
 *
 * \`maxSubRows\` is the token budget expressed in text rows. Whole grid rows are
 * taken while they fit — clipping mid-row would leave columns ending at different
 * heights and destroy the alignment the packing exists for.
 */
export function rasterGrid(plan, shape, maxSubRows, options = {}) {
  if (!plan || !Array.isArray(plan.rows) || plan.rows.length === 0) return undefined;
  const cap = Math.floor(Math.min(Number(maxSubRows) || 0, shape.frameH / shape.cellH));
  if (cap <= 0) return undefined;

  const taken = [];
  const drawn = [];
  let subRows = 0;
  for (const row of plan.rows) {
    if (subRows + row.subRows > cap) break;
    taken.push(row);
    subRows += row.subRows;
    for (const cell of row.cells) for (const part of cell) if (part !== "") drawn.push(part);
  }
  if (taken.length === 0 || subRows <= 0) return undefined;

  const w = shape.frameW;
  const h = subRows * shape.cellH;
  const pixels = new Uint8Array(w * h);
  const paper = options.paper ?? PAPER;
  const ruleInk = options.rule ?? RULE;
  const rulerInk = options.gutterInk ?? GUTTER_INK;
  pixels.fill(paper);
  // Optional band shading. A row's ruler sits at its first column, so a value 120
  // columns away has nothing tying it to that row; a shade band ties it for free.
  if (typeof options.rowPaper === "function") {
    let y0 = 0;
    for (let r = 0; r < taken.length; r++) {
      const y1 = y0 + taken[r].subRows * shape.cellH;
      const shade = options.rowPaper(r);
      if (shade !== undefined && shade !== null) pixels.fill(shade, y0 * w, y1 * w);
      y0 = y1;
    }
  }

  const gutterCols = plan.gutterCols ?? 0;
  const gutterW = gutterCols * shape.cellW;
  const stride = plan.cellCols + plan.gapCols;
  const every = plan.gutterEvery || 5;
  let y = 0;
  for (let r = 0; r < taken.length; r++) {
    const row = taken[r];
    const rowH = row.subRows * shape.cellH;
    if (gutterCols > 0) {
      if (r % every === 0) {
        drawCells(pixels, w, 0, y, [String(row.startLine)], gutterCols - 1, shape, rulerInk);
      }
      for (let yy = y; yy < y + rowH; yy++) put(pixels, w, gutterW - shape.cellW, yy, ruleInk);
    }
    for (let j = 0; j < row.cells.length; j++) {
      const wide = row.wide === true;
      const x = wide ? gutterW : gutterW + j * stride * shape.cellW;
      if (!wide && j > 0) {
        const ruleX = x - Math.ceil(plan.gapCols / 2) * shape.cellW;
        for (let yy = y; yy < y + rowH; yy++) put(pixels, w, ruleX, yy, ruleInk);
      }
      const bodyInk = typeof options.cellInk === "function" ? options.cellInk(row.cells[j]) : INK;
      drawCells(pixels, w, x, y, row.cells[j], wide ? (plan.contentCols ?? plan.cellCols) : plan.cellCols, shape, bodyInk, options.digitInk);
    }
    y += rowH;
  }
  let sourceLines = 0;
  for (const row of taken) sourceLines += row.cells.length;
  return {
    pixels,
    w,
    h,
    rows: subRows,
    gridRows: taken.length,
    sourceLines,
    wideRows: taken.filter((row) => row.wide === true).length,
    columns: plan.columns,
    cellCols: plan.cellCols,
    gutterCols,
    renderedText: drawn.join("\n")
  };
}
