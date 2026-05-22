import { describe, expect, it } from "vitest";
import {
  composeRecoveryMetrics,
  estimateValueSavings,
  formatDurationMs,
  DEFAULT_VALUE_ASSUMPTIONS,
  type RecoveryMetricsSignals,
} from "./recovery-metrics";

function baseSignals(partial: Partial<RecoveryMetricsSignals> = {}): RecoveryMetricsSignals {
  return {
    runStatusCounts: { succeeded: 0, failed: 0, cancelled: 0, running: 0, queued: 0, total: 0 },
    mttrDurations: [],
    approvalsPending: 0,
    costByProvider: [],
    p95LatencyMs: null,
    replayOutcomes: { totalEntries: 0, replayedSuccess: 0, replayedAndReopened: 0 },
    resolvedClusters: { totalClusters: 0, totalEntries: 0, capped: false },
    ...partial,
  };
}

describe("composeRecoveryMetrics — successRate band", () => {
  it("95/100 succeeded → healthy", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ runStatusCounts: { succeeded: 95, failed: 4, cancelled: 1, running: 0, queued: 0, total: 100 } }),
      30,
    );
    expect(result.successRate.severity).toBe("healthy");
    expect(result.successRate.display).toBe("95.0%");
    expect(result.successRate.rationaleCode).toBe("success_rate.summary");
    expect(result.successRate.rationaleMeta).toMatchObject({ succeeded: 95, terminal: 100 });
  });

  it("86/100 succeeded → warn", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ runStatusCounts: { succeeded: 86, failed: 12, cancelled: 2, running: 0, queued: 0, total: 100 } }),
      30,
    );
    expect(result.successRate.severity).toBe("warn");
  });

  it("50/100 succeeded → unhealthy", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ runStatusCounts: { succeeded: 50, failed: 40, cancelled: 10, running: 0, queued: 0, total: 100 } }),
      30,
    );
    expect(result.successRate.severity).toBe("unhealthy");
  });

  it("no terminal runs → null + neutral", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ runStatusCounts: { succeeded: 0, failed: 0, cancelled: 0, running: 5, queued: 2, total: 7 } }),
      30,
    );
    expect(result.successRate.value).toBe(null);
    expect(result.successRate.severity).toBe("neutral");
    expect(result.successRate.rationaleCode).toBe("success_rate.empty");
  });
});

describe("composeRecoveryMetrics — MTTR formatting + bands", () => {
  it("avg ~1.8s → healthy + 1.8s display", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ mttrDurations: [1500, 1800, 2200] }),
      30,
    );
    expect(result.mttr.severity).toBe("healthy");
    expect(result.mttr.display).toBe("1.8s");
  });

  it("avg 300_000ms (5min) → warn", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ mttrDurations: [300_000, 300_000] }),
      30,
    );
    expect(result.mttr.severity).toBe("warn");
  });

  it("avg 1_200_000ms → unhealthy", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ mttrDurations: [1_200_000] }),
      30,
    );
    expect(result.mttr.severity).toBe("unhealthy");
  });

  it("empty durations → null + neutral", () => {
    const result = composeRecoveryMetrics(baseSignals(), 30);
    expect(result.mttr.value).toBe(null);
    expect(result.mttr.severity).toBe("neutral");
  });
});

describe("composeRecoveryMetrics — p95 latency", () => {
  it("4_000ms → healthy", () => {
    const result = composeRecoveryMetrics(baseSignals({ p95LatencyMs: 4_000 }), 30);
    expect(result.p95Latency.severity).toBe("healthy");
  });
  it("15_000ms → warn", () => {
    const result = composeRecoveryMetrics(baseSignals({ p95LatencyMs: 15_000 }), 30);
    expect(result.p95Latency.severity).toBe("warn");
  });
  it("40_000ms → unhealthy", () => {
    const result = composeRecoveryMetrics(baseSignals({ p95LatencyMs: 40_000 }), 30);
    expect(result.p95Latency.severity).toBe("unhealthy");
  });
});

describe("composeRecoveryMetrics — approvals + replay rate", () => {
  it("approvals: 0 → healthy; 3 → neutral; 12 → warn", () => {
    expect(composeRecoveryMetrics(baseSignals({ approvalsPending: 0 }), 30).approvalsPending.severity).toBe("healthy");
    expect(composeRecoveryMetrics(baseSignals({ approvalsPending: 3 }), 30).approvalsPending.severity).toBe("neutral");
    expect(composeRecoveryMetrics(baseSignals({ approvalsPending: 12 }), 30).approvalsPending.severity).toBe("warn");
  });

  it("replay rate 9/10 → healthy", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ replayOutcomes: { totalEntries: 10, replayedSuccess: 9, replayedAndReopened: 1 } }),
      30,
    );
    expect(result.replayRate.severity).toBe("healthy");
    expect(result.replayRate.display).toBe("90.0%");
  });

  it("replay rate 5/10 → unhealthy", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ replayOutcomes: { totalEntries: 10, replayedSuccess: 5, replayedAndReopened: 5 } }),
      30,
    );
    expect(result.replayRate.severity).toBe("unhealthy");
  });
});

describe("composeRecoveryMetrics — cost rollup", () => {
  it("groups providers, totals USD, sorts desc, displays canonical names", () => {
    const result = composeRecoveryMetrics(
      baseSignals({
        costByProvider: [
          { provider: "openai", model: "gpt-4o", usd: 5.5, tokens: 100_000, calls: 50 },
          { provider: "anthropic", model: "claude-haiku-4-5", usd: 12.3, tokens: 200_000, calls: 80 },
          { provider: "openai", model: "gpt-4o-mini", usd: 1.2, tokens: 30_000, calls: 20 },
        ],
      }),
      30,
    );
    expect(result.costThisWindow.value).toBeCloseTo(19.0, 1);
    expect(result.costThisWindow.display).toBe("$19.00");
    expect(result.costThisWindow.providers[0]).toMatchObject({ provider: "Anthropic", usd: 12.3 });
    expect(result.costThisWindow.providers[1]).toMatchObject({ provider: "OpenAI", usd: 5.5 });
    expect(result.costThisWindow.severity).toBe("neutral");
  });
});

describe("formatDurationMs — direct unit checks", () => {
  it("renders sub-second as ms, then 1.4s, then 3m 12s, then 1h 5m", () => {
    expect(formatDurationMs(450)).toBe("450ms");
    expect(formatDurationMs(1_400)).toBe("1.4s");
    expect(formatDurationMs(192_000)).toBe("3m 12s");
    expect(formatDurationMs(3_900_000)).toBe("1h 5m");
  });
});

describe("estimateValueSavings — formula correctness", () => {
  it("computes hoursSaved + dollarSaved from the operator assumptions", () => {
    // 10 clusters × 30 min / 60 × $50/hr = $250 saved (5 hours)
    const result = estimateValueSavings(10, 60, DEFAULT_VALUE_ASSUMPTIONS);
    expect(result.hoursSaved).toBe(5);
    expect(result.dollarSaved).toBe(250);
  });

  it("zero clusters → zero savings (the empty-state contract)", () => {
    const result = estimateValueSavings(0, 60, DEFAULT_VALUE_ASSUMPTIONS);
    expect(result.hoursSaved).toBe(0);
    expect(result.dollarSaved).toBe(0);
  });

  it("treats baselineMttrSeconds === 0 as 'unset' (mttrDelta null)", () => {
    const result = estimateValueSavings(5, 60, DEFAULT_VALUE_ASSUMPTIONS);
    expect(result.mttrDeltaSeconds).toBeNull();
    expect(result.assumptions.baselineMttrSeconds).toBe(0);
  });

  it("computes mttrDelta when baseline is set and measured MTTR is available", () => {
    const result = estimateValueSavings(5, 60, {
      ...DEFAULT_VALUE_ASSUMPTIONS,
      baselineMttrSeconds: 1800, // 30-min manual baseline
    });
    expect(result.mttrDeltaSeconds).toBe(1740); // 1800 - 60 = 1740s
  });

  it("returns null mttrDelta when measuredMttrSeconds is null (no replays yet)", () => {
    const result = estimateValueSavings(5, null, {
      ...DEFAULT_VALUE_ASSUMPTIONS,
      baselineMttrSeconds: 1800,
    });
    expect(result.mttrDeltaSeconds).toBeNull();
  });

  it("negative clustersResolved is clamped to zero (defense against bad input)", () => {
    const result = estimateValueSavings(-5, 60, DEFAULT_VALUE_ASSUMPTIONS);
    expect(result.hoursSaved).toBe(0);
    expect(result.dollarSaved).toBe(0);
  });
});

describe("composeRecoveryMetrics — clustersResolved + valueEstimate", () => {
  it("zero clusters → neutral severity, empty rationale code", () => {
    const result = composeRecoveryMetrics(baseSignals(), 30);
    expect(result.clustersResolved.value).toBe(0);
    expect(result.clustersResolved.severity).toBe("neutral");
    expect(result.clustersResolved.rationaleCode).toBe("clusters_resolved.empty");
    expect(result.valueEstimate.hoursSaved).toBe(0);
    expect(result.valueEstimate.dollarSaved).toBe(0);
  });

  it("positive clusters → healthy severity, populated rationaleMeta", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ resolvedClusters: { totalClusters: 7, totalEntries: 23, capped: false } }),
      30,
    );
    expect(result.clustersResolved.value).toBe(7);
    expect(result.clustersResolved.severity).toBe("healthy");
    expect(result.clustersResolved.display).toBe("7 clusters");
    expect(result.clustersResolved.rationaleCode).toBe("clusters_resolved.summary");
    expect(result.clustersResolved.rationaleMeta).toMatchObject({
      distinctSignatures: 7,
      totalEntries: 23,
      capped: false,
    });
  });

  it("capped scan renders 'at-least' display", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ resolvedClusters: { totalClusters: 50, totalEntries: 10_000, capped: true } }),
      30,
    );
    expect(result.clustersResolved.display).toBe("≥ 50 clusters");
    expect(result.clustersResolved.capped).toBe(true);
  });

  it("valueEstimate populated from custom assumptions", () => {
    const result = composeRecoveryMetrics(
      baseSignals({ resolvedClusters: { totalClusters: 10, totalEntries: 30, capped: false } }),
      30,
      { hourlyCost: 100, minutesSavedPerRecovery: 60, baselineMttrSeconds: 0 },
    );
    expect(result.valueEstimate.hoursSaved).toBe(10); // 10 × 60 / 60
    expect(result.valueEstimate.dollarSaved).toBe(1000); // 10 × $100
    expect(result.valueEstimate.mttrDeltaSeconds).toBeNull(); // baseline unset
    expect(result.valueEstimate.assumptions.hourlyCost).toBe(100);
  });
});
