#!/usr/bin/env node
/**
 * Static checks for the merged package.
 *
 * Two failure modes are cheap to introduce and expensive to notice:
 *
 * 1. A vendored module that uses a name it never imported. The extraction split
 *    one compiled bundle into separate ES modules, and a name that the bundle
 *    resolved from another region silently becomes a `ReferenceError` — but only
 *    on the code path that reaches it, which may be an error branch.
 * 2. A manifest that declares a client half the Loader cannot resolve. The boot
 *    audit then fails the whole app rather than this one plugin.
 *
 * Both are checked here without booting the harness.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// --- 1. every module resolves every free identifier it uses -------------------
/** Names that are always available in an ES module. */
const GLOBALS = new Set([
  "Object", "JSON", "Math", "Set", "Map", "Array", "String", "Number", "Boolean",
  "Error", "TypeError", "RangeError", "AbortController", "AbortSignal", "Promise",
  "Date", "Buffer", "Infinity", "NaN", "Symbol", "WeakRef", "WeakSet", "WeakMap",
  "RegExp", "BigInt", "Proxy", "Reflect", "URL", "Uint8Array", "Float64Array",
  "Int32Array", "structuredClone", "decodeURIComponent", "encodeURIComponent",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "console", "process", "globalThis", "undefined", "arguments", "fetch", "window",
  "document", "MutationObserver", "HTMLElement", "Node", "Request", "Response",
  "require", "exports", "module", "TextEncoder", "TextDecoder", "isFinite",
  "parseInt", "parseFloat", "Intl"
]);

/** Reserved words and declaration keywords: never identifiers to resolve. */
const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "finally", "for", "function", "if",
  "import", "in", "instanceof", "let", "new", "return", "super", "switch", "this",
  "throw", "try", "typeof", "var", "void", "while", "with", "yield", "await",
  "async", "of", "static", "get", "set", "from", "as"
]);

/** Strip comments and string literals so identifier scanning cannot see prose. */
function stripSource(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "`str`")
    .replace(/"(?:\\.|[^"\\])*"/g, '"str"')
    .replace(/'(?:\\.|[^'\\])*'/g, "'str'");
}

/** Collect every name the module binds at top level, plus its imports. */
function boundNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/^import\s+(?:\{([^}]*)\}|(\w+))\s+from/gm)) {
    if (match[1]) for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
    if (match[2]) names.add(match[2]);
  }
  for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^(?:export\s+)?class\s+(\w+)/gm)) names.add(match[1]);
  return names;
}

/** Declarations nested anywhere (they are still in scope for their block). */
function allDeclaredNames(text) {
  const names = boundNames(text);
  for (const match of text.matchAll(/(?:^|[\s({;,])?(?:const|let|var)\s+(\w+)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/function\s+(\w+)\s*\(/g)) names.add(match[1]);
  for (const match of text.matchAll(/class\s+(\w+)/g)) names.add(match[1]);
  for (const match of text.matchAll(/catch\s*\(\s*(\w+)\s*\)/g)) names.add(match[1]);
  // Arrow parameters and `(a, b) =>` lists.
  for (const match of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of text.matchAll(/(?:^|[\s({,;])([A-Za-z_$][\w$]*)\s*=>/gm)) names.add(match[1]);
  // Object-literal method shorthands: `name(args) {` and `async name(args) {`.
  for (const match of text.matchAll(/(?:^|[\s{,])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) names.add(match[1]);
  // Class methods: `name(args) {`, `async name(args) {`, `get name()`, and
  // methods whose parameters carry defaults that themselves contain parentheses
  // (`configured(config = this.settings.get()) {`).
  for (const match of text.matchAll(/^[ \t]*(?:async[ \t]+|static[ \t]+|get[ \t]+|set[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*\(.*\)[ \t]*\{[ \t]*$/gm)) {
    names.add(match[1]);
  }
  return names;
}

const hostModules = [
  "lib/index.js",
  "lib/config.js",
  "lib/controller.js",
  "lib/typert.js",
  "lib/compact-core.js",
  "lib/pressure.js",
  "lib/routes.js",
  ...readdirSync(join(root, "lib/ledger"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `lib/ledger/${name}`)
];

const reported = [];
for (const relative of hostModules) {
  const text = readFileSync(join(root, relative), "utf8");
  const declared = allDeclaredNames(text);
  const stripped = stripSource(text);
  const seen = new Set();
  for (const match of stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?=\()/g)) {
    const name = match[1];
    if (KEYWORDS.has(name) || seen.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
    seen.add(name);
    reported.push(`${relative}: ${name}`);
  }
  // Class methods reached through a receiver alias. `self`/`this` inside a method
  // refer to the class instance, whose own methods are declarations too.
  for (const match of stripped.matchAll(/\b(?:self|this)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (declared.has(name)) continue;
    reported.push(`${relative}: self.${name}`);
  }
}
// A property access (`obj.name`) is excluded by the lookbehind above; what is left
// is a call or index on a bare identifier that nothing binds.
assert.deepEqual(reported, [], `unbound identifiers:\n  ${reported.join("\n  ")}`);

// --- 2. the manifest matches what the Loader looks for -----------------------
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.type, "module");
assert.ok(manifest.dsh?.client, "dsh.client is the only discovery entry for a browser half");
assert.equal(manifest.dsh.client.platform, "web");
assert.ok(Array.isArray(manifest.dsh.client.inject), "dsh.client.inject must list the client services it needs");
const clientPath = manifest.exports["./client"];
assert.ok(clientPath, "a declared dsh.client requires an exports[\"./client\"] bundle");
assert.ok(existsSync(join(root, clientPath)), `missing client bundle: ${clientPath}`);
assert.ok(existsSync(join(root, manifest.main)), `missing host entry: ${manifest.main}`);

const patch = readFileSync(join(root, manifest.dsh.bundle.patch), "utf8");
assert.match(patch, new RegExp(manifest.name), "the bundle patch must insert this package");
assert.ok(!patch.includes("dsh-ledger-compact\n"), "the patch must not re-insert a retired plugin");

// Every host module must be reachable from the entry, or it is dead weight that
// still runs its top-level imports at package load.
const indexSource = readFileSync(join(root, "lib/index.js"), "utf8");
for (const relative of hostModules) {
  if (relative === "lib/index.js") continue;
  const specifier = "./" + relative.slice("lib/".length);
  const isDirect = indexSource.includes(`"${specifier}"`) || indexSource.includes(`"${specifier.replace(/\.js$/, ".js")}"`);
  const reachable = isDirect || hostModules.some((other) => {
    if (other === relative) return false;
    const source = readFileSync(join(root, other), "utf8");
    return source.includes(relative.replace("lib/", "./")) || source.includes(relative.split("/").pop());
  });
  assert.ok(reachable, `${relative} is not imported by anything`);
}

console.log(`OK: ${hostModules.length} host modules, all identifiers bound`);
console.log(`    client: ${clientPath}, host: ${manifest.main}, patch: ${manifest.dsh.bundle.patch}`);
