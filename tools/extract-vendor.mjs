#!/usr/bin/env node
/**
 * One-time extraction of the saviour browser primitives.
 *
 * dsh-compact-saviour ships a single compiled bundle. The merged plugin reuses the
 * inert parts of it (runtime helpers, DOM probes, meter bridge, ring control,
 * waiting copy, stylesheet) and replaces the rest. This script cuts those regions
 * out by marker so the copy stays faithful and the boundary is auditable — run it
 * again after upgrading the saviour package.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * Source bundle to cut from.
 *
 * Resolved from the caller's own profile rather than a fixed path: the extraction
 * is a maintenance step run on the machine that has dsh-compact-saviour installed,
 * and pinning one developer's absolute path would make the script unusable
 * anywhere else. Override with SAVIOUR_SOURCE when the profile lives elsewhere.
 */
const SOURCE = process.env.SAVIOUR_SOURCE
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "profiles", "desktop",
    "node_modules", "dsh-compact-saviour", "lib", "client.js");
const OUT_UI = join(root, "lib/client-vendor/saviour-ui.js");
const OUT_CSS = join(root, "lib/client-vendor/saviour.css.js");

const lines = readFileSync(SOURCE, "utf8").split("\n");

/** 1-based inclusive slice, like sed. */
const take = (from, to) => lines.slice(from - 1, to).join("\n");

const header = `/**
 * Vendored browser primitives from dsh-compact-saviour 0.2.8 (MIT, (c) 2026 aa2246740).
 *
 * The inert pieces the merged plugin reuses verbatim: the rolldown runtime
 * helpers, the native context ring DOM probes, the reversible meter bridge, the
 * ring status control with its animation, and the waiting copy. They
 * are copied rather than reimplemented because each encodes a specific
 * measurement of this harness DOM, and a rewrite would have to rediscover it.
 *
 * One region is deliberately not reused as-is: upstream's ring fired a compaction
 * on a 650 ms hold, and this plugin drops that gesture. Rather than editing the
 * extracted text by hand (the next run would overwrite it), this script finishes
 * by running tools/strip-ring-gesture.mjs, which removes the gesture with
 * asserted replacements and refuses to run if upstream's text has moved.
 *
 * The other edit is mechanical: the module wrapper is gone. tools/build-client.mjs
 * splices this text into the merged factory, which supplies react/react-dom.
 */

`;

// Bundle layout, verified against the published file: runtime helpers start at
// line 7, the injected stylesheet is one statement after the last UI region, and
// the plugin's own index.tsx factory starts after that.
const UI_FROM = 7;
const UI_TO = 5494;
const CSS_LINE = 5497;

writeFileSync(OUT_UI, header + take(UI_FROM, UI_TO) + "\n");

const cssStatement = lines[CSS_LINE - 1];
const prefix = "\t\tconst css = ";
if (!cssStatement.startsWith(prefix) || !cssStatement.endsWith(";")) {
  throw new Error(`unexpected stylesheet statement at line ${CSS_LINE}: ${cssStatement.slice(0, 80)}`);
}
const literal = cssStatement.slice(prefix.length, -1);
if (JSON.parse(literal).length < 1000) throw new Error("stylesheet literal looks truncated");

writeFileSync(OUT_CSS, `/** Vendored stylesheet from dsh-compact-saviour 0.2.8 (MIT). */
export const saviourCss = ${literal};
`);

console.log(`ui: ${take(UI_FROM, UI_TO).split("\n").length} lines`);
console.log(`css: ${JSON.parse(literal).length} chars`);

/**
 * Re-apply this plugin's own edit to the freshly extracted chunk.
 *
 * Upstream's ring fires a compaction on a 650 ms hold, and this plugin does not
 * want that gesture. The removal lives in its own script so it can be asserted
 * piece by piece rather than applied as a line-range cut — an earlier range cut
 * also deleted the SVG helpers `Satellite` needs, which threw at construction and
 * left the popup native. Running it here means a re-extraction cannot silently
 * bring the gesture back.
 */
const stripping = spawnSync(process.execPath, [join(here, "strip-ring-gesture.mjs")], { stdio: "inherit" });
if (stripping.status !== 0) process.exit(stripping.status ?? 1);

