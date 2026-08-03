// Pure repeated A/B benchmark policy. The runner owns process and database
// lifecycle; this module compares an exact candidate with the frozen baseline
// in co-scheduled windows on separate fresh PostgreSQL 18 instances.

export const BENCHMARK_CAMPAIGN_POLICY_VERSION = 4;
export const MIN_BENCHMARK_SAMPLES = 5;
export const MAX_BENCHMARK_SAMPLES = 9;

export const BENCHMARK_METRICS = Object.freeze([
  { id: "start.ratePerSec", direction: "higher", label: "Linear runs / second" },
  { id: "start.p50", direction: "lower", label: "Linear p50 latency" },
  { id: "start.p95", direction: "lower", label: "Linear p95 latency" },
  { id: "start.p99", direction: "lower", label: "Linear p99 latency" },
  { id: "list.ratePerSec", direction: "higher", label: "Run-list reads / second" },
  { id: "list.p50", direction: "lower", label: "Run-list p50 latency" },
  { id: "list.p95", direction: "lower", label: "Run-list p95 latency" },
  { id: "list.p99", direction: "lower", label: "Run-list p99 latency" },
  { id: "diamond.ratePerSec", direction: "higher", label: "Diamond runs / second" },
  { id: "diamond.p50", direction: "lower", label: "Diamond p50 latency" },
  { id: "diamond.p95", direction: "lower", label: "Diamond p95 latency" },
  { id: "diamond.p99", direction: "lower", label: "Diamond p99 latency" },
]);

const MEDIAN_REGRESSION_LIMIT = 0.25;
const SEVERE_PAIR_REGRESSION_LIMIT = 0.50;
const RATIO_VARIATION_LIMIT = 0.30;

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function pick(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function finiteMetric(value, direction) {
  return Number.isFinite(value) && (direction === "higher" ? value > 0 : value >= 0);
}

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[rank - 1];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function coefficientOfVariation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function candidateMatches(sample, candidate) {
  return sample?.candidate?.commit === candidate.commit && sample?.candidate?.tree === candidate.tree;
}

function baselineMatches(sample, baseline) {
  return sample?.baseline?.commit === baseline.sourceCommit && sample?.baseline?.tree === baseline.sourceTree;
}

function validateSummary(summary, sampleNumber, side, blockers) {
  if (summary?.durationSeconds !== 20) {
    blockers.push(issue("sample_duration_invalid", `${side} scenario duration drifted from 20 seconds`, {
      sample: sampleNumber, side,
    }));
  }
  const errors = summary?.errors;
  if (!Number.isInteger(errors) || errors < 0) {
    blockers.push(issue("sample_errors_invalid", `${side} benchmark error count is invalid`, {
      sample: sampleNumber, side,
    }));
  } else if (errors !== 0) {
    blockers.push(issue("sample_errors", `${side} benchmark recorded request or terminal errors`, {
      sample: sampleNumber, side, errors,
    }));
  }
  for (const family of ["start", "list", "diamond"]) {
    const iterations = summary?.[family]?.iterations;
    const rate = summary?.[family]?.ratePerSec;
    if (!Number.isInteger(iterations) || iterations <= 0 || !Number.isFinite(rate) || rate <= 0 ||
        Math.abs(rate - (iterations / 20)) > 1e-9) {
      blockers.push(issue("sample_throughput_invalid", `${side} ${family} iterations and rate are inconsistent`, {
        sample: sampleNumber, side, family,
      }));
    }
  }
}

/** Evaluate three to nine fresh-database A/B pairs against one Git baseline. */
export function evaluateBenchmarkCampaign({ candidate, baseline, samples, sourceTreeUnchanged }) {
  const blockers = [];
  const warnings = [];
  if (!/^[0-9a-f]{40}$/u.test(candidate?.commit ?? "") || !/^[0-9a-f]{40}$/u.test(candidate?.tree ?? "")) {
    blockers.push(issue("candidate_identity_invalid", "Benchmark candidate commit and tree must be full Git object ids"));
  }
  if (baseline?.schemaVersion !== 1 || baseline?.policyVersion !== BENCHMARK_CAMPAIGN_POLICY_VERSION) {
    blockers.push(issue("baseline_schema_unsupported", "Benchmark baseline schema or policy is unsupported"));
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(baseline?.id ?? "")) {
    blockers.push(issue("baseline_id_invalid", "Benchmark baseline id is required"));
  }
  if (!/^[0-9a-f]{40}$/u.test(baseline?.sourceCommit ?? "") || !/^[0-9a-f]{40}$/u.test(baseline?.sourceTree ?? "")) {
    blockers.push(issue("baseline_provenance_invalid", "Benchmark baseline commit and tree are required"));
  }
  if (!Array.isArray(samples) || samples.length < MIN_BENCHMARK_SAMPLES || samples.length > MAX_BENCHMARK_SAMPLES) {
    blockers.push(issue(
      "sample_count_invalid",
      `Benchmark campaign requires ${MIN_BENCHMARK_SAMPLES}-${MAX_BENCHMARK_SAMPLES} A/B pairs`,
      { sampleCount: Array.isArray(samples) ? samples.length : null },
    ));
  }
  if (sourceTreeUnchanged !== true) {
    blockers.push(issue("source_tree_changed", "Benchmark campaign changed the candidate source tree"));
  }

  const safeSamples = Array.isArray(samples) ? samples : [];
  const aggregate = {
    sampleCount: safeSamples.length,
    candidateErrors: 0,
    baselineErrors: 0,
    metrics: {},
  };
  let previousCapturedAt = Number.NEGATIVE_INFINITY;
  for (const [index, sample] of safeSamples.entries()) {
    const sampleNumber = index + 1;
    if (!candidateMatches(sample, candidate)) {
      blockers.push(issue("sample_candidate_mismatch", "Benchmark sample belongs to another candidate", { sample: sampleNumber }));
    }
    if (!baselineMatches(sample, baseline)) {
      blockers.push(issue("sample_baseline_mismatch", "Benchmark sample belongs to another baseline", { sample: sampleNumber }));
    }
    if (sample.index !== sampleNumber || sample.execution !== "concurrent") {
      blockers.push(issue("sample_execution_invalid", "Benchmark pairs must co-schedule candidate and baseline", {
        sample: sampleNumber,
      }));
    }
    const capturedAt = Date.parse(sample.capturedAt ?? "");
    if (!/^[0-9a-f]{64}$/u.test(sample.candidateSummarySha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(sample.baselineSummarySha256 ?? "") ||
        !Number.isFinite(capturedAt) || capturedAt <= previousCapturedAt) {
      blockers.push(issue("sample_provenance_invalid", "Benchmark pair hashes and capture timestamp are required", {
        sample: sampleNumber,
      }));
    }
    if (Number.isFinite(capturedAt)) previousCapturedAt = capturedAt;
    validateSummary(sample.candidateSummary, sampleNumber, "candidate", blockers);
    validateSummary(sample.baselineSummary, sampleNumber, "baseline", blockers);
    if (Number.isInteger(sample.candidateSummary?.errors)) aggregate.candidateErrors += sample.candidateSummary.errors;
    if (Number.isInteger(sample.baselineSummary?.errors)) aggregate.baselineErrors += sample.baselineSummary.errors;
  }

  for (const metric of BENCHMARK_METRICS) {
    const candidateValues = safeSamples.map(sample => pick(sample.candidateSummary, metric.id));
    const baselineValues = safeSamples.map(sample => pick(sample.baselineSummary, metric.id));
    if (candidateValues.length === 0 || candidateValues.some(value => !finiteMetric(value, metric.direction)) ||
        baselineValues.some(value => !finiteMetric(value, metric.direction) || value === 0)) {
      blockers.push(issue("sample_metric_invalid", `Benchmark pairs are missing ${metric.id}`, { metric: metric.id }));
      continue;
    }
    const ratios = candidateValues.map((value, index) => value / baselineValues[index]);
    const medianRatio = median(ratios);
    const ratioP95 = percentile(ratios, 0.95);
    const worstRatio = metric.direction === "higher" ? Math.min(...ratios) : Math.max(...ratios);
    const variation = coefficientOfVariation(ratios);
    aggregate.metrics[metric.id] = {
      direction: metric.direction,
      baselineMedian: median(baselineValues),
      candidateMedian: median(candidateValues),
      medianRatio,
      ratioP95,
      worstRatio,
      severePairCount: 0,
      coefficientOfVariation: variation,
    };
    const medianRegressed = metric.direction === "higher"
      ? medianRatio < 1 - MEDIAN_REGRESSION_LIMIT
      : medianRatio > 1 + MEDIAN_REGRESSION_LIMIT;
    if (medianRegressed) {
      blockers.push(issue("median_regression", `${metric.id} paired median regressed beyond 25%`, {
        metric: metric.id, medianRatio,
      }));
    }
    const severePairIndexes = ratios.flatMap((ratio, index) => {
      const regressed = metric.direction === "higher"
        ? ratio < 1 - SEVERE_PAIR_REGRESSION_LIMIT
        : ratio > 1 + SEVERE_PAIR_REGRESSION_LIMIT;
      return regressed ? [index + 1] : [];
    });
    aggregate.metrics[metric.id].severePairCount = severePairIndexes.length;
    if (severePairIndexes.length >= 2) {
      blockers.push(issue("repeatable_pair_regression", `${metric.id} regressed beyond 50% in multiple pairs`, {
        metric: metric.id, worstRatio, severePairIndexes,
      }));
    } else if (severePairIndexes.length === 1) {
      warnings.push(issue("isolated_pair_outlier", `${metric.id} had one unconfirmed pair beyond 50%`, {
        metric: metric.id, worstRatio, severePairIndexes,
      }));
    }
    if (variation > RATIO_VARIATION_LIMIT) {
      blockers.push(issue("campaign_unstable", `${metric.id} paired ratios vary by more than 30%`, {
        metric: metric.id, coefficientOfVariation: variation,
      }));
    }
  }

  return { pass: blockers.length === 0, blockers, warnings, aggregate };
}

export function formatBenchmarkCampaign(receipt) {
  const lines = [
    "# Janusly Go co-scheduled A/B benchmark campaign",
    "",
    `- Candidate: \`${receipt.candidate.commit}\``,
    `- Tree: \`${receipt.candidate.tree}\``,
    `- Baseline: \`${receipt.baseline.sourceCommit}\``,
    `- Co-scheduled fresh-database pairs: ${receipt.aggregate.sampleCount}`,
    `- Candidate errors: ${receipt.aggregate.candidateErrors}`,
    `- Baseline errors: ${receipt.aggregate.baselineErrors}`,
    `- Verdict: **${receipt.pass ? "PASS" : "FAIL"}**`,
    "",
    "| Metric | Baseline median | Candidate median | Median ratio | Ratio p95 | Worst ratio | Verdict |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const blockerMetrics = new Set(receipt.blockers.map(blocker => blocker.metric).filter(Boolean));
  const warningMetrics = new Set(receipt.warnings.map(warning => warning.metric).filter(Boolean));
  for (const metric of BENCHMARK_METRICS) {
    const row = receipt.aggregate.metrics[metric.id];
    if (!row) continue;
    const verdict = blockerMetrics.has(metric.id) ? "FAIL" : warningMetrics.has(metric.id) ? "WARN" : "PASS";
    lines.push(`| ${metric.label} | ${row.baselineMedian.toFixed(2)} | ${row.candidateMedian.toFixed(2)} | ${row.medianRatio.toFixed(3)}x | ${row.ratioP95.toFixed(3)}x | ${row.worstRatio.toFixed(3)}x | ${verdict} |`);
  }
  lines.push("", "## Blockers", "");
  if (receipt.blockers.length === 0) lines.push("- None.");
  else for (const blocker of receipt.blockers) lines.push(`- \`${blocker.code}\`: ${blocker.message}`);
  lines.push("", "## Warnings", "");
  if (receipt.warnings.length === 0) lines.push("- None.");
  else for (const warning of receipt.warnings) lines.push(`- \`${warning.code}\`: ${warning.message}`);
  return `${lines.join("\n")}\n`;
}
