/**
 * Surgical removal of the ring's long-press gesture, done as asserted literal
 * replacements on the pristine vendored file.
 *
 * Line-range surgery is what broke the ring the first time: the cut also took
 * `element`, `orbitTime` and `settleFrame`, which `Satellite` needs, so the
 * control threw on construction and the popup fell back to native. Every
 * replacement here names exactly one piece of the gesture, and fails loudly if
 * the upstream text does not match.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "lib/client-vendor/saviour-ui.js";
let text = readFileSync(path, "utf8");
const before = text;

/** Replace once; throw when the anchor is absent or ambiguous. */
function cut(from, to, label) {
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`${label}: expected 1 match, found ${hits}`);
  text = text.replace(from, to);
}

// 1. Gesture-only instance state. `available` existed only for `canHold()`.
cut(
  "\t\t\tactivate;\n\t\t\thost = document.createElement(\"span\");\n\t\t\tbot;\n\t\t\ttimer;\n\t\t\tpointer;\n\t\t\tsuppressedUntil = 0;\n\t\t\tphase = \"idle\";\n\t\t\tavailable = false;\n",
  "\t\t\thost = document.createElement(\"span\");\n\t\t\tbot;\n\t\t\tphase = \"idle\";\n",
  "gesture fields");

// 2. The `activate` callback had no other caller.
cut(
  "\t\t\tconstructor(button, activate) {\n\t\t\t\tthis.button = button;\n\t\t\t\tthis.activate = activate;\n",
  "\t\t\tconstructor(button) {\n\t\t\t\tthis.button = button;\n",
  "constructor signature");

// 3. The hold ring itself. The satellite robot below it stays.
cut(
  "\t\t\t\tthis.host.innerHTML = \"<svg class=\\\"dsh-cs-hold\\\" viewBox=\\\"0 0 32 32\\\"><circle cx=\\\"16\\\" cy=\\\"16\\\" r=\\\"14\\\" pathLength=\\\"1\\\"/></svg>\";\n",
  "",
  "hold ring markup");

// 4. Every listener that existed to drive the gesture.
cut(
  "\t\t\t\tbutton.addEventListener(\"pointerdown\", this.down);\n"
  + "\t\t\t\tbutton.addEventListener(\"pointerleave\", this.cancel);\n"
  + "\t\t\t\tbutton.addEventListener(\"pointercancel\", this.cancel);\n"
  + "\t\t\t\tbutton.addEventListener(\"contextmenu\", this.context);\n"
  + "\t\t\t\tbutton.addEventListener(\"click\", this.click, true);\n"
  + "\t\t\t\twindow.addEventListener(\"pointerup\", this.up, true);\n"
  + "\t\t\t\twindow.addEventListener(\"pointermove\", this.move, true);\n"
  + "\t\t\t\twindow.addEventListener(\"pointerdown\", this.anotherPointer, true);\n"
  + "\t\t\t\twindow.addEventListener(\"blur\", this.cancel);\n"
  + "\t\t\t\tdocument.addEventListener(\"visibilitychange\", this.cancel);\n",
  "",
  "gesture listeners");

// 5. `available` only gated the gesture.
cut(
  "\t\t\tupdate(phase, available) {\n\t\t\t\tthis.available = available;\n",
  "\t\t\tupdate(phase) {\n",
  "update signature");

// 6. The gesture needs cancelling when the phase changes; without it, nothing.
cut(
  "\t\t\t\tthis.lastTitle = title;\n\t\t\t\tif (!this.canHold()) this.cancel();\n",
  "\t\t\t\tthis.lastTitle = title;\n",
  "phase cancel");

// 7. The tooltip promised the gesture.
cut(
  "点击查看上下文 · 长按压缩",
  "点击查看上下文",
  "ring tooltip");

// 8. The whole gesture state machine: canHold, down, anotherPointer, move, up,
//    context, click and cancel. It runs from `canHold()` to the closing brace of
//    `cancel()`; `destroy()` follows immediately.
const gestureStart = "\t\t\tcanHold() {\n";
const gestureEnd = "\t\t\tdestroy() {\n";
const start = text.indexOf(gestureStart);
const end = text.indexOf(gestureEnd, start);
if (start < 0 || end < 0 || end < start) throw new Error("gesture block not found");
text = text.slice(0, start) + text.slice(end);

// 9. destroy() only had to unbind those listeners and drop the hold class.
cut(
  "\t\t\t\tthis.disposed = true;\n\t\t\t\tthis.cancel();\n\t\t\t\tthis.bot.destroy();\n",
  "\t\t\t\tthis.disposed = true;\n\t\t\t\tthis.bot.destroy();\n",
  "destroy cancel");
cut(
  "\t\t\t\tthis.button.removeEventListener(\"pointerdown\", this.down);\n"
  + "\t\t\t\tthis.button.removeEventListener(\"pointerleave\", this.cancel);\n"
  + "\t\t\t\tthis.button.removeEventListener(\"pointercancel\", this.cancel);\n"
  + "\t\t\t\tthis.button.removeEventListener(\"contextmenu\", this.context);\n"
  + "\t\t\t\tthis.button.removeEventListener(\"click\", this.click, true);\n"
  + "\t\t\t\twindow.removeEventListener(\"pointerup\", this.up, true);\n"
  + "\t\t\t\twindow.removeEventListener(\"pointermove\", this.move, true);\n"
  + "\t\t\t\twindow.removeEventListener(\"pointerdown\", this.anotherPointer, true);\n"
  + "\t\t\t\twindow.removeEventListener(\"blur\", this.cancel);\n"
  + "\t\t\t\tdocument.removeEventListener(\"visibilitychange\", this.cancel);\n",
  "",
  "destroy unbinding");

// The helpers Satellite depends on must still be there.
for (const kept of ["const element = (tag)", "const orbitTime =", "function settleFrame(", "var Satellite = class", "let nextClip = 0"]) {
  if (!text.includes(kept)) throw new Error(`removal took a helper Satellite needs: ${kept}`);
}
for (const gone of ["csHolding", "canHold", "this.activate", "cs-hold"]) {
  if (text.includes(gone)) throw new Error(`gesture remnant survived: ${gone}`);
}

writeFileSync(path, text);
console.log(`removed ${before.split("\n").length - text.split("\n").length} lines`);
