/**
 * Unit tests for the pure eval-gate logic (`scripts/evals-baseline.mjs`).
 *
 * Uses node's built-in test runner (zero deps, no Compose, no API, no
 * provider credits) so the gate semantics are pinned independently of a live
 * eval run. Invoked via `pnpm test:evals` (`node --test scripts/*.test.mjs`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { compareToBaseline, gateRun, summarizeAi } from "./evals-baseline.mjs";

const baseline = { aiModeRate: 0.8, shapePassRate: 0.7, tolerance: 0.1 };

function aiCase({ skipped = false, aiMode = true, shapePass = true } = {}) {
  return { requiresAi: true, skipped, aiMode, shapePass };
}

test("summarizeAi computes rates over non-skipped AI cases", () => {
  const results = [
    aiCase({ aiMode: true, shapePass: true }),
    aiCase({ aiMode: true, shapePass: false }),
    aiCase({ aiMode: false, shapePass: false }),
    aiCase({ skipped: true }), // excluded from denominators
    { requiresAi: false }, // deterministic — excluded
  ];
  const s = summarizeAi(results);
  assert.equal(s.aiCaseCount, 3);
  assert.equal(s.aiModeRate.toFixed(4), (2 / 3).toFixed(4));
  assert.equal(s.shapePassRate.toFixed(4), (1 / 3).toFixed(4));
});

test("summarizeAi returns aiCaseCount 0 when every AI case is skipped (no-key run)", () => {
  const s = summarizeAi([aiCase({ skipped: true }), aiCase({ skipped: true }), { requiresAi: false }]);
  assert.deepEqual(s, { aiCaseCount: 0, aiModeRate: 0, shapePassRate: 0 });
});

test("compareToBaseline flags a metric that drops past the tolerance band", () => {
  const cmp = compareToBaseline({ aiCaseCount: 10, aiModeRate: 0.5, shapePassRate: 0.9 }, baseline);
  assert.equal(cmp.regressed, true);
  assert.equal(cmp.failures.length, 1);
  assert.match(cmp.failures[0], /ai-mode rate/);
});

test("compareToBaseline passes inside the tolerance band", () => {
  // 0.72 >= 0.8 - 0.1; 0.65 >= 0.7 - 0.1 → no regression.
  const cmp = compareToBaseline({ aiCaseCount: 10, aiModeRate: 0.72, shapePassRate: 0.65 }, baseline);
  assert.equal(cmp.regressed, false);
  assert.deepEqual(cmp.failures, []);
});

test("gateRun fails on a hard failure regardless of healthy AI rates", () => {
  const observed = summarizeAi([aiCase(), aiCase()]);
  const d = gateRun({ hardFailures: 1, observed, baseline });
  assert.equal(d.failed, true);
  assert.match(d.reasons[0], /hard failure/);
});

test("gateRun skips the rate gate when no AI case ran (no-key run stays green)", () => {
  const observed = summarizeAi([aiCase({ skipped: true }), aiCase({ skipped: true })]);
  const d = gateRun({ hardFailures: 0, observed, baseline });
  assert.equal(d.failed, false);
  assert.deepEqual(d.reasons, []);
});

test("gateRun fails on a real AI-rate regression", () => {
  const observed = summarizeAi([
    aiCase({ aiMode: false, shapePass: false }),
    aiCase({ aiMode: false, shapePass: false }),
    aiCase({ aiMode: true, shapePass: true }),
    aiCase({ aiMode: true, shapePass: true }),
  ]); // aiModeRate 0.5 → below 0.8 - 0.1
  const d = gateRun({ hardFailures: 0, observed, baseline });
  assert.equal(d.failed, true);
  assert.ok(d.reasons.length >= 1);
});

test("gateRun passes a healthy keyed run", () => {
  const observed = summarizeAi([aiCase(), aiCase(), aiCase(), aiCase(), aiCase()]); // 1.0 / 1.0
  const d = gateRun({ hardFailures: 0, observed, baseline });
  assert.equal(d.failed, false);
});
