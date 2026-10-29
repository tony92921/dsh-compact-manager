#!/usr/bin/env node
/**
 * Unbound-identifier scan for the browser half.
 *
 * `tools/probe-client.mjs` catches a broken component by rendering it, but only
 * for the components it names and only on the branch that executes. A constant
 * used in an error path or a rarely taken branch still hides until a user hits it.
 *
 * This scan is exhaustive and syntax-only: it collects every binding the bundle
 * declares (module scope, function scope and catch/arrow parameters) and reports
 * any capitalised identifier — the convention this codebase uses for module
 * constants, which is exactly the class of name that goes missing when code is
 * moved between files — that nothing binds.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

/** Remove comments and string/template contents so prose cannot be scanned. */
function strip(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "`s`")
    .replace(/"(?:\\.|[^"\\])*"/g, '"s"')
    .replace(/'(?:\\.|[^'\\])*'/g, "'s'");
}

const code = strip(source);

const declared = new Set();
const declare = (name) => { if (name) declared.add(name); };

for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declare(match[1]);
for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declare(match[1]);
for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declare(match[1]);
for (const match of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declare(match[1]);
// Function and method parameters, including defaults and destructuring.
for (const match of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const part of match[1].split(",")) {
    const name = part.trim().split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declare(name);
  }
}
// Bare arrow parameters: `x => ...`
for (const match of code.matchAll(/(?:^|[\s({,;])([A-Za-z_$][\w$]*)\s*=>/g)) declare(match[1]);
// Destructuring targets: `const { a, b: c } = ...`
for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
  for (const part of match[1].split(",")) {
    const name = part.split(":").pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declare(name);
  }
}

/** Host objects the browser provides. */
const HOST = new Set([
  "React", "ReactDOM", "Symbol", "Object", "JSON", "Math", "Set", "Map", "Array",
  "String", "Number", "Boolean", "Error", "TypeError", "Promise", "Date", "Infinity",
  "NaN", "RegExp", "AbortController", "WeakRef", "MutationObserver", "HTMLElement",
  "Node", "URL", "Intl", "globalThis", "undefined", "isFinite", "parseInt"
]);

const missing = [];
const seen = new Set();
// Capitalised identifiers, per the module-constant convention.
for (const match of code.matchAll(/(?<![.\w$'"`])([A-Z][A-Z0-9_]{2,})\b/g)) {
  const name = match[1];
  if (seen.has(name) || HOST.has(name) || declared.has(name)) continue;
  seen.add(name);
  const at = code.slice(0, match.index).split("\n").length;
  missing.push(`line ${at}: ${name}`);
}

assert.deepEqual(missing, [], `unbound constants in lib/client.js:\n  ${missing.join("\n  ")}`);

console.log(`OK: every capitalised identifier in lib/client.js is bound (${declared.size} bindings)`);
