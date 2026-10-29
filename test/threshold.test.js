/**
 * Tests for the automatic-compaction trigger resolver.
 *
 * The formula is three lines long, so the interesting part is not that it
 * multiplies correctly — it is which of the two limits wins, and what the page is
 * allowed to claim once it does. Every test below fixes one of those claims:
 *
 * - a large window is governed by the ratio, a small one by the fixed headroom
 * - an impossible configuration reports *why* instead of returning a number
 * - a retain ratio that would swallow the whole compactable region is clamped
 *   rather than left to make every compaction silently find nothing
 *
 * These matter because the same function decides what the settings page promises
 * and what the Host enforces; a disagreement between them is invisible until a
 * compaction fails to fire.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, describeThreshold, resolveThreshold } from "../lib/threshold.js";

const DEFAULTS = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 };

test("a large window is governed by the ratio, not by headroom", () => {
  // 1M window: 800,000 by ratio vs 901,696 by headroom — the ratio is tighter.
  const spec = resolveThreshold(1_000_000, 32768, DEFAULTS);
  assert.equal(spec.known, true);
  assert.equal(spec.byRatio, 800_000);
  assert.equal(spec.byHeadroom, 901_696);
  assert.equal(spec.thresholdTokens, 800_000);
  assert.equal(spec.cappedBy, "ratio");
  assert.equal(spec.thresholdPercent, 80);
});

test("a small window is governed by the fixed headroom, which is why it fires early", () => {
  // 131,072 window: 25% of the way in, the 65536 absolute headroom has already
  // eaten the budget. This is the case that looks like a bug and is not.
  const spec = resolveThreshold(131_072, 32768, DEFAULTS);
  assert.equal(spec.known, true);
  assert.equal(spec.byRatio, 104_857);
  assert.equal(spec.byHeadroom, 32_768);
  assert.equal(spec.thresholdTokens, 32_768);
  assert.equal(spec.cappedBy, "headroom");
  assert.equal(Math.round(spec.thresholdPercent), 25);
});

test("the crossover window is where the two limits meet", () => {
  // Solving 0.8W = W - 32768 - 65536 gives W = 491,520. Just under it headroom
  // wins; just over it the ratio does.
  const below = resolveThreshold(490_000, 32768, DEFAULTS);
  const above = resolveThreshold(493_000, 32768, DEFAULTS);
  assert.equal(below.cappedBy, "headroom");
  assert.equal(above.cappedBy, "ratio");
});

test("a 200K window lands between the two regimes", () => {
  const spec = resolveThreshold(200_000, 32768, DEFAULTS);
  assert.equal(spec.thresholdTokens, 101_696, "message budget 167,232 minus headroom 65,536");
  assert.equal(spec.cappedBy, "headroom");
  assert.ok(Math.abs(spec.thresholdPercent - 50.8) < 0.1);
});

test("retain is a fraction of the message budget, not of the window", () => {
  const spec = resolveThreshold(1_000_000, 32768, DEFAULTS);
  // (1,000,000 - 32,768) × 0.16 = 154,757, not 1,000,000 × 0.16.
  assert.equal(spec.retainTokens, Math.floor((1_000_000 - 32768) * 0.16));
  assert.equal(spec.retainClamped, false);
});

test("an unknown window reports why instead of inventing a number", () => {
  for (const value of [0, -1, NaN, undefined]) {
    const spec = resolveThreshold(value, 32768, DEFAULTS);
    assert.equal(spec.known, false, `window ${value} must not produce a trigger`);
    assert.equal(spec.reason, "no-window");
  }
});

test("a headroom that eats the whole message budget is reported, not hidden", () => {
  // This configuration never compacts: pressureBudget <= 0 makes the official
  // engine throw, so the page must say so rather than show "0 tok".
  const spec = resolveThreshold(100_000, 32768, { ...DEFAULTS, headroomTokens: 80_000 });
  assert.equal(spec.known, false);
  assert.equal(spec.reason, "headroom-over-budget");
  assert.equal(spec.messageBudget, 67_232);
});

test("an output reservation larger than the window is reported", () => {
  const spec = resolveThreshold(10_000, 20_000, DEFAULTS);
  assert.equal(spec.known, false);
  assert.equal(spec.reason, "reserved-over-window");
});

test("a retain ratio that would swallow the compactable region is clamped", () => {
  // 50% retain on a 1M window gives 483,616 tokens, well above a 80,000 threshold.
  // Left alone, selectCompactableRange would refuse every single time.
  const spec = resolveThreshold(1_000_000, 32768, { thresholdRatio: 0.15, headroomTokens: 65536, retainRatio: 0.5 });
  assert.equal(spec.known, true);
  assert.equal(spec.thresholdTokens, 150_000);
  assert.equal(spec.retainClamped, true);
  assert.equal(spec.retainTokens, 75_000, "clamped to half the threshold");
  assert.ok(spec.retainTokens < spec.thresholdTokens);
});

test("inputs are clamped into the supported range instead of rejected", () => {
  const spec = resolveThreshold(1_000_000, 0, { thresholdRatio: 5, headroomTokens: -100, retainRatio: 9 });
  assert.equal(spec.known, true);
  assert.equal(spec.thresholdRatio, LIMITS.ratio.max);
  assert.equal(spec.headroomTokens, LIMITS.headroom.min);
  assert.equal(spec.retainRatio, LIMITS.retain.max);
});

test("description names the limit that won, so the number is readable", () => {
  const large = describeThreshold(resolveThreshold(1_000_000, 32768, DEFAULTS));
  assert.match(large, /由触发线比例决定/);
  const small = describeThreshold(resolveThreshold(131_072, 32768, DEFAULTS));
  assert.match(small, /由预留空间决定/);
});

test("description explains an unresolvable configuration in words", () => {
  assert.match(describeThreshold(resolveThreshold(0, 0, DEFAULTS)), /无法计算/);
  const blocked = describeThreshold(resolveThreshold(100_000, 32768, { ...DEFAULTS, headroomTokens: 80_000 }));
  assert.match(blocked, /吃满|无法计算/);
});

test("the trigger never exceeds the window it is measured against", () => {
  for (const window of [8_192, 32_768, 131_072, 200_000, 1_000_000, 2_000_000]) {
    for (const reserved of [0, 4_096, 32_768, 128_000]) {
      const spec = resolveThreshold(window, reserved, DEFAULTS);
      if (!spec.known) continue;
      assert.ok(spec.thresholdTokens > 0, `window ${window}/${reserved} must allow a trigger`);
      assert.ok(spec.thresholdTokens <= window, "a trigger outside the window would never fire");
      assert.ok(spec.retainTokens < spec.thresholdTokens, "the retained tail must leave something foldable");
    }
  }
});
