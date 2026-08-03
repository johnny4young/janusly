import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_CAMPAIGN_POLICY_VERSION,
  evaluateBenchmarkCampaign,
  formatBenchmarkCampaign,
} from "./benchmark-campaign-policy.mjs";

const candidate = { commit: "a".repeat(40), tree: "b".repeat(40) };

function baseline() {
  return {
    schemaVersion: 1,
    policyVersion: BENCHMARK_CAMPAIGN_POLICY_VERSION,
    id: "test-baseline",
    sourceCommit: "c".repeat(40),
    sourceTree: "d".repeat(40),
  };
}

function summary(value = 100) {
  return {
    durationSeconds: 20,
    start: { iterations: value * 20, ratePerSec: value, p50: value, p95: value, p99: value },
    list: { iterations: value * 20, ratePerSec: value, p50: value, p95: value, p99: value },
    diamond: { iterations: value * 20, ratePerSec: value, p50: value, p95: value, p99: value },
    errors: 0,
  };
}

function samples(candidateValues = [98, 99, 100, 101, 102], baselineValues = [100, 100, 100, 100, 100]) {
  return candidateValues.map((value, index) => ({
    index: index + 1,
    execution: "concurrent",
    candidate: { ...candidate },
    baseline: { commit: baseline().sourceCommit, tree: baseline().sourceTree },
    capturedAt: `2026-08-03T14:0${index}:00.000Z`,
    candidateSummarySha256: String(index + 1).repeat(64),
    baselineSummarySha256: String(index + 4).repeat(64),
    candidateSummary: summary(value),
    baselineSummary: summary(baselineValues[index]),
  }));
}

test("five exact stable A/B pairs pass and render paired ratios", () => {
  const verdict = evaluateBenchmarkCampaign({ candidate, baseline: baseline(), samples: samples(), sourceTreeUnchanged: true });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.aggregate.sampleCount, 5);
  assert.equal(verdict.aggregate.metrics["start.ratePerSec"].medianRatio, 1);
  assert.equal(verdict.aggregate.metrics["start.ratePerSec"].ratioP95, 1.02);
  assert.match(formatBenchmarkCampaign({ candidate, baseline: baseline(), ...verdict }), /Verdict: \*\*PASS\*\*/u);
});

test("one green pair cannot certify a campaign", () => {
  const verdict = evaluateBenchmarkCampaign({ candidate, baseline: baseline(), samples: samples([100], [100]), sourceTreeUnchanged: true });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_count_invalid"), true);
});

test("candidate, baseline, and evidence drift plus errors fail closed", () => {
  const rows = samples();
  rows[1].candidate.tree = "0".repeat(40);
  rows[1].baseline.tree = "1".repeat(40);
  rows[1].execution = "sequential";
  rows[2].capturedAt = rows[1].capturedAt;
  rows[2].baselineSummary.errors = 1;
  const verdict = evaluateBenchmarkCampaign({ candidate, baseline: baseline(), samples: rows, sourceTreeUnchanged: true });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_candidate_mismatch"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_baseline_mismatch"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_execution_invalid"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_provenance_invalid"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "sample_errors" && blocker.side === "baseline"), true);
});

test("median regression, repeated bad pairs, and unstable ratios are distinct blockers", () => {
  const verdict = evaluateBenchmarkCampaign({
    candidate,
    baseline: baseline(),
    samples: samples([45, 45, 70, 100, 100], [100, 100, 100, 100, 100]),
    sourceTreeUnchanged: true,
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "median_regression"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "repeatable_pair_regression"), true);
  assert.equal(verdict.blockers.some(blocker => blocker.code === "campaign_unstable"), true);
});

test("one severe but unconfirmed pair remains visible without failing a stable campaign", () => {
  const verdict = evaluateBenchmarkCampaign({
    candidate,
    baseline: baseline(),
    samples: samples([45, 100, 100, 100, 100], [100, 100, 100, 100, 100]),
    sourceTreeUnchanged: true,
  });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.blockers.length, 0);
  assert.equal(verdict.warnings.some(warning => warning.code === "isolated_pair_outlier"), true);
  assert.match(formatBenchmarkCampaign({ candidate, baseline: baseline(), ...verdict }), /Verdict: \*\*PASS\*\*[\s\S]*WARN/u);
});

test("latency regressions use the opposite direction from throughput", () => {
  const rows = samples([100, 100, 100]);
  for (const row of rows) {
    for (const family of ["start", "list", "diamond"]) {
      row.candidateSummary[family].p50 = 140;
      row.candidateSummary[family].p95 = 140;
      row.candidateSummary[family].p99 = 140;
    }
  }
  const verdict = evaluateBenchmarkCampaign({ candidate, baseline: baseline(), samples: rows, sourceTreeUnchanged: true });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.blockers.some(blocker =>
    blocker.code === "median_regression" && blocker.metric === "start.p95"), true);
  assert.equal(verdict.blockers.some(blocker =>
    blocker.code === "median_regression" && blocker.metric === "start.ratePerSec"), false);
});
