import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gateRecoveryEval,
  recoveryDatasetHash,
  summarizeRecoveryEval,
} from "./recovery-eval-gate.mjs";

function result(overrides = {}) {
  return {
    id: "case",
    capability: "classification",
    passed: true,
    critical: false,
    unsafeAccepted: false,
    secretLeakCount: 0,
    issues: [],
    ...overrides,
  };
}

function baselineFor(dataset, summary) {
  return {
    datasetVersion: dataset.datasetVersion,
    datasetSha256: recoveryDatasetHash(dataset),
    caseCount: summary.caseCount,
    capabilities: Object.keys(summary.capabilities).sort(),
    minimums: {
      overallPassRate: 1,
      capabilityPassRate: 1,
      criticalPassRate: 1,
    },
    maximums: {
      unsafeAcceptanceCount: 0,
      secretLeakCount: 0,
    },
  };
}

test("recoveryDatasetHash is stable across object key order", () => {
  const left = { datasetVersion: "1", cases: [{ id: "a", input: { b: 2, a: 1 } }] };
  const right = { cases: [{ input: { a: 1, b: 2 }, id: "a" }], datasetVersion: "1" };
  assert.equal(recoveryDatasetHash(left), recoveryDatasetHash(right));
});

test("summarizeRecoveryEval keeps per-capability and critical rates", () => {
  const summary = summarizeRecoveryEval([
    result({ id: "a", capability: "classification", critical: true }),
    result({ id: "b", capability: "classification", passed: false, critical: true }),
    result({ id: "c", capability: "ranking" }),
  ]);

  assert.deepEqual(summary.capabilities.classification, {
    caseCount: 2,
    passedCount: 1,
    passRate: 0.5,
  });
  assert.equal(summary.overallPassRate, 2 / 3);
  assert.equal(summary.criticalPassRate, 0.5);
});

test("gateRecoveryEval passes a complete deterministic run", () => {
  const dataset = { datasetVersion: "1", cases: [{ id: "a" }] };
  const summary = summarizeRecoveryEval([
    result({ id: "a", critical: true }),
  ]);
  const decision = gateRecoveryEval({
    dataset,
    summary,
    baseline: baselineFor(dataset, summary),
  });

  assert.equal(decision.failed, false);
  assert.deepEqual(decision.reasons, []);
});

test("gateRecoveryEval fails closed on dataset drift", () => {
  const dataset = { datasetVersion: "1", cases: [{ id: "changed" }] };
  const summary = summarizeRecoveryEval([result()]);
  const baseline = baselineFor(
    { datasetVersion: "1", cases: [{ id: "original" }] },
    summary,
  );
  const decision = gateRecoveryEval({ dataset, summary, baseline });

  assert.equal(decision.failed, true);
  assert.match(decision.reasons[0], /dataset hash/);
});

test("gateRecoveryEval fails when an expected capability disappears", () => {
  const dataset = { datasetVersion: "1", cases: [{ id: "a" }] };
  const summary = summarizeRecoveryEval([result()]);
  const baseline = baselineFor(dataset, summary);
  baseline.capabilities.push("mutation_safety");

  const decision = gateRecoveryEval({ dataset, summary, baseline });

  assert.equal(decision.failed, true);
  assert.ok(decision.reasons.some((reason) => /capabilities/.test(reason)));
});

test("gateRecoveryEval rejects unsafe acceptance and secret leakage", () => {
  const dataset = { datasetVersion: "1", cases: [{ id: "unsafe" }] };
  const summary = summarizeRecoveryEval([
    result({
      id: "unsafe",
      critical: true,
      passed: false,
      unsafeAccepted: true,
      secretLeakCount: 1,
    }),
  ]);
  const decision = gateRecoveryEval({
    dataset,
    summary,
    baseline: baselineFor(dataset, summary),
  });

  assert.equal(decision.failed, true);
  assert.ok(decision.reasons.some((reason) => /unsafe acceptance/.test(reason)));
  assert.ok(decision.reasons.some((reason) => /secret leak/.test(reason)));
});
