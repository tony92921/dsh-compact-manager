/** Grid layout for the dense image.
 *
 * The bill for an ingress PNG is area-based: a 512px tile band costs the same
 * whether it is packed or blank. So the layout's only job is to put as many
 * informative cells on the paid canvas as possible without shredding legibility.
 *
 * This module is pure data — it never touches pixels; snapfont.js rasterizes the
 * plan. Reading order is row-major (left to right, then down) so a packed grid
 * still reads like a page, and every grid row remembers the source line it starts
 * at, which is what makes the rendered line ruler meaningful.
 */

import { cellsOf } from "./snapfont.js";

export const LAYOUT_DEFAULTS = {
  /** Upper bound on packed columns; ties prefer the fewest columns. */
  maxColumns: 24,
  /** A cell narrower than this stops being readable as a separate column. */
  minCellCols: 4,
  /** Blank cells between columns so the eye (and the encoder) can tell them apart. */
  gapCols: 2,
  /** Below this many source lines a line ruler costs more width than it is worth. */
  gutterMinLines: 50,
  /**
   * Print the source line number every N grid rows. Measured: `1` (every row) lifts
   * exact-value accuracy from 73% to 87% at identical capacity and cost, because the
   * dominant error class is reading the wrong line (bench/report.md).
   */
  gutterEvery: 1,
  /** Column search runs on at most this many sampled lines. */
  searchSample: 4000,
  /**
   * Share of cells a candidate may break across sub-rows before it is rejected.
   * Wrapping raises occupancy on paper but shreds the one-line-per-cell promise
   * the grid exists for, so only genuine outliers are allowed to wrap.
   */
  maxWrapShare: 0.02,
  /**
   * A cell may break a line across at most this many sub-rows. Anything wider
   * gets its own full-width row instead of being shredded into a narrow column —
   * a header or a long path stays readable in the middle of a packed grid.
   */
  maxCellSubRows: 2
};

/** Display width of one line in cells (wide CJK counts as two). */
export function cellLength(line) {
  const value = String(line ?? "");
  let used = 0;
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 63;
    used += cellsOf(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return used;
}

/** Split one source line into the sub-rows it needs inside a cell. */
export function wrapCell(line, cellCols) {
  const value = String(line ?? "");
  if (value === "") return [""];
  const parts = [];
  let start = 0;
  let used = 0;
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i) ?? 63;
    const width = cellsOf(cp);
    if (used > 0 && used + width > cellCols) {
      parts.push(value.slice(start, i));
      start = i;
      used = 0;
      continue;
    }
    used += width;
    i += cp > 0xffff ? 2 : 1;
  }
  // A line that ends exactly on the cell edge must not grow an empty extra row.
  if (start < value.length || parts.length === 0) parts.push(value.slice(start));
  return parts;
}

function sampleLines(lines, max) {
  if (lines.length <= max) return lines;
  const out = [];
  for (let i = 0; i < max; i++) out.push(lines[Math.floor((i * lines.length) / max)]);
  return out;
}

/**
 * Build the grid for one column count. A grid row is as tall as its tallest
 * cell, so one wrapped outlier costs rows only where it actually sits.
 */
export function buildGrid(lines, options) {
  const { columns, cellCols, gapCols, cols, gutterCols, gutterEvery, maxCellSubRows, contentCols } = options;
  const wideCols = contentCols ?? cols - gutterCols;
  const rows = [];
  let usedCells = 0;
  let totalSubRows = 0;
  let wrappedCells = 0;
  let placed = 0;
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    let subRows = 1;
    for (const cell of buffer) if (cell.parts.length > subRows) subRows = cell.parts.length;
    rows.push({ wide: false, cells: buffer.map((cell) => cell.parts), subRows, startLine: buffer[0].line });
    totalSubRows += subRows;
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i] ?? "");
    const parts = wrapCell(text, cellCols);
    placed += 1;
    usedCells += cellLength(text);
    if (parts.length > maxCellSubRows) {
      // Too wide for a packed cell: give it the full width instead of shredding it.
      flush();
      const wideParts = wrapCell(text, wideCols);
      rows.push({ wide: true, cells: [wideParts], subRows: wideParts.length, startLine: i + 1 });
      totalSubRows += wideParts.length;
      continue;
    }
    if (parts.length > 1) wrappedCells += 1;
    buffer.push({ parts, line: i + 1 });
    if (buffer.length === columns) flush();
  }
  flush();

  const capacity = totalSubRows * cols;
  return {
    columns,
    cellCols,
    contentCols: wideCols,
    gapCols,
    gutterCols,
    gutterEvery,
    rows,
    totalSubRows,
    usedCells,
    capacity,
    wrappedCells,
    wrapShare: placed > 0 ? wrappedCells / placed : 0,
    occupancy: capacity > 0 ? usedCells / capacity : 0
  };
}

/**
 * Pick the column count that fills the paid canvas best, then build the real
 * grid. Occupancy is measured against the *whole* frame width, so gutters and
 * gaps are charged to the layout that asks for them.
 */
export function planGrid(lines, shape, options = {}) {
  const cfg = { ...LAYOUT_DEFAULTS, ...options };
  const source = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  if (source.length === 0) return undefined;
  const gutterCols = source.length >= cfg.gutterMinLines
    ? Math.max(3, String(source.length).length + 1)
    : 0;
  const contentCols = shape.cols - gutterCols;
  const probe = sampleLines(source, cfg.searchSample);
  const fixed = {
    cols: shape.cols,
    gutterCols,
    gutterEvery: cfg.gutterEvery,
    gapCols: cfg.gapCols,
    maxCellSubRows: cfg.maxCellSubRows,
    contentCols
  };
  let best;
  let unguarded;
  for (let columns = 1; columns <= cfg.maxColumns; columns++) {
    const cellCols = Math.floor((contentCols - (columns - 1) * cfg.gapCols) / columns);
    if (cellCols < cfg.minCellCols) break;
    const candidate = buildGrid(probe, { ...fixed, columns, cellCols });
    if (!unguarded || candidate.occupancy > unguarded.occupancy + 1e-9) unguarded = candidate;
    if (candidate.wrapShare > cfg.maxWrapShare) continue;
    if (!best || candidate.occupancy > best.occupancy + 1e-9) best = candidate;
  }
  // Lines wider than the whole canvas have to wrap somewhere; once wrapping is
  // unavoidable the guard loses its point and the densest grid wins after all.
  if (!best) best = unguarded;
  if (!best) {
    best = buildGrid(probe, { ...fixed, columns: 1, cellCols: Math.max(1, contentCols) });
  }
  if (probe === source) return best;
  return buildGrid(source, { ...fixed, columns: best.columns, cellCols: best.cellCols });
}
