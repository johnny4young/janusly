/**
 * Pure rollup that turns the raw recovery-metrics signals collected by
 * `packages/data/src/recoveryMetricsRepo.ts` into the UI-friendly shape
 * the Operations dashboard renders. Each metric carries:
 *
 *   - `value` — the numeric driving the chip / progress bar (or `null`
 *     when the window has no data).
 *   - `display` — pre-formatted human string (`"92.3%"` / `"1m 30s"` /
 *     `"$12.50"`).
 *   - `severity` — `healthy` / `warn` / `unhealthy` / `neutral` for the
 *     card's left-border colour.
 *   - `rationale` — short hover/expand text.
 *
 * Bands are documented inline as exported constants so future tuning
 * lives in one place and tests can pin the edges. Pure function — no
 * I/O, no DB, no network. Used by
 * `apps/api/src/routes/recovery-routes.ts:GET /recovery/metrics`.
 *
 * Out of scope by design: "auto-fixes suggested/applied" and "rollbacks
 * triggered" counters — both need new audit-log actions that don't
 * exist yet. When the recovery apply path lands, those signals plug in
 * here as additional metrics.
 */

/** Severity tier for a single metric card. */
export type MetricSeverity = "healthy" | "warn" | "unhealthy" | "neutral";

export type RecoveryMetricRationaleCode =
  | "success_rate.empty"
  | "success_rate.summary"
  | "mttr.empty"
  | "mttr.summary"
  | "latency.insufficient"
  | "latency.summary"
  | "approvals.none"
  | "approvals.blocked"
  | "replay.empty"
  | "replay.summary"
  | "cost.summary"
  | "clusters_resolved.empty"
  | "clusters_resolved.summary"
  | "sla_attainment.empty"
  | "sla_attainment.summary";

/** Per-provider/model row inside the cost breakdown. */
export type CostProviderRow = {
  provider: string;
  model: string;
  usd: number;
  tokens: number;
  calls: number;
};

/** Run-status counts collected by the repo over the window. */
export type RunStatusCounts = {
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  total: number;
};

/** Replay outcome counts the repo derives from `dead_letters.status`. */
export type ReplayOutcomeCounts = {
  totalEntries: number;
  replayedSuccess: number;
  replayedAndReopened: number;
};

/**
 * Distinct-failure-signature counts the repo derives from
 * `dead_letters` rows in the window with `status IN (replayed, resolved)`.
 * `capped: true` means the underlying scan hit the row cap and the
 * `totalClusters` count is bounded by whatever fit.
 */
export type ResolvedClustersCounts = {
  totalClusters: number;
  totalEntries: number;
  capped: boolean;
};

/**
 * SLA-attainment counts over recovery items resolved in the window.
 * `metSla` = the subset resolved before their `slaTargetAt` deadline;
 * attainment % = `metSla / resolvedInWindow`.
 */
export type SlaAttainmentCounts = {
  resolvedInWindow: number;
  metSla: number;
};

/** Raw signals the data repo returns; the rollup converts to `RecoveryMetrics`. */
export type RecoveryMetricsSignals = {
  runStatusCounts: RunStatusCounts;
  /** Recovery durations (ms) for replayed DLQ rows. */
  mttrDurations: number[];
  approvalsPending: number;
  costByProvider: CostProviderRow[];
  p95LatencyMs: number | null;
  replayOutcomes: ReplayOutcomeCounts;
  resolvedClusters: ResolvedClustersCounts;
  slaAttainment: SlaAttainmentCounts;
};

/** Single metric card payload surfaced to the UI. */
export type RecoveryMetric = {
  value: number | null;
  display: string;
  severity: MetricSeverity;
  rationale: string;
  rationaleCode: RecoveryMetricRationaleCode;
  rationaleMeta?: Record<string, string | number | boolean>;
};

/**
 * Operator-supplied assumptions that drive the Value Dashboard's
 * estimate formulas. Every dollar / hour surface labeled as estimate
 * in the UI traces back to these knobs.
 */
export type ValueAssumptions = {
  /** Engineer hourly cost (USD-equivalent). Pure assumption — never measured. */
  hourlyCost: number;
  /** Minutes a human would otherwise spend per resolved failure. Operator-supplied. */
  minutesSavedPerRecovery: number;
  /**
   * Pre-Janusly MTTR baseline (seconds). `0` is the sentinel for
   * "baseline not measured yet" — the dashboard renders the "Before"
   * slot as "Awaiting private-beta data" until set.
   */
  baselineMttrSeconds: number;
};

/**
 * Value Dashboard rollup. Computed from `resolvedClusters` × the
 * three operator-supplied `ValueAssumptions`. Every numeric in this
 * block is an ESTIMATE; the UI labels them as such, the export
 * Markdown spells out the formula plainly.
 *
 * `mttrDeltaSeconds` is null when the baseline is unset (0 sentinel)
 * OR when the platform's measured MTTR is unavailable.
 */
export type ValueEstimate = {
  hoursSaved: number;
  dollarSaved: number;
  mttrDeltaSeconds: number | null;
  assumptions: ValueAssumptions;
};

/** Full UI-friendly rollup returned by `composeRecoveryMetrics`. */
export type RecoveryMetrics = {
  successRate: RecoveryMetric;
  mttr: RecoveryMetric;
  p95Latency: RecoveryMetric;
  approvalsPending: RecoveryMetric;
  replayRate: RecoveryMetric;
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[] };
  clustersResolved: RecoveryMetric & { totalEntries: number; capped: boolean };
  slaAttainment: RecoveryMetric & { resolvedInWindow: number; metSla: number };
  valueEstimate: ValueEstimate;
  windowDays: number;
  /** Total terminal runs (succeeded + failed + cancelled) — useful as the denominator for downstream per-workflow rollups. */
  terminalRuns: number;
};

/* ----------------------------- Severity bands ----------------------------- */

export const SUCCESS_RATE_BANDS = { healthy: 95, warn: 85 } as const;
export const MTTR_BANDS_MS = { healthy: 2 * 60 * 1000, warn: 15 * 60 * 1000 } as const;
export const LATENCY_BANDS_MS = { healthy: 5_000, warn: 30_000 } as const;
export const APPROVALS_BANDS = { neutralMax: 5, warnAbove: 5 } as const;
export const REPLAY_RATE_BANDS = { healthy: 90, warn: 70 } as const;
export const SLA_ATTAINMENT_BANDS = { healthy: 90, warn: 75 } as const;

/* ----------------------------- Provider lookup --------------------------- */

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  google: "Google",
  mistral: "Mistral",
};

function displayProvider(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider.toLowerCase()] ?? provider;
}

/** Default assumptions when the org has not customised `value.*`. Match the
 *  catalog defaults in `packages/data/src/orgConfigRepo.ts`. */
export const DEFAULT_VALUE_ASSUMPTIONS: ValueAssumptions = {
  hourlyCost: 50,
  minutesSavedPerRecovery: 30,
  baselineMttrSeconds: 0,
};

/**
 * Compute the value-savings estimate from a cluster count + the
 * platform's measured MTTR (in seconds) + operator assumptions.
 *
 * Pure function — exported so the export route + tests can call it
 * directly without spinning up the full rollup.
 *
 * Formula:
 *   hoursSaved  = clustersResolved * minutesSavedPerRecovery / 60
 *   dollarSaved = hoursSaved * hourlyCost
 *   mttrDelta   = baselineMttrSeconds > 0 && mttrSeconds != null
 *                   ? baselineMttrSeconds - mttrSeconds
 *                   : null
 *
 * `baselineMttrSeconds === 0` is the sentinel for "operator has not
 * measured a pre-Janusly baseline yet"; in that case `mttrDeltaSeconds`
 * is `null` and the UI renders "Awaiting private-beta data".
 */
export function estimateValueSavings(
  clustersResolved: number,
  measuredMttrSeconds: number | null,
  assumptions: ValueAssumptions,
): ValueEstimate {
  const safeClusters = Math.max(0, clustersResolved);
  const hoursSaved = safeClusters * assumptions.minutesSavedPerRecovery / 60;
  const dollarSaved = hoursSaved * assumptions.hourlyCost;
  const mttrDeltaSeconds =
    assumptions.baselineMttrSeconds > 0 && measuredMttrSeconds != null
      ? assumptions.baselineMttrSeconds - measuredMttrSeconds
      : null;
  return {
    hoursSaved,
    dollarSaved,
    mttrDeltaSeconds,
    assumptions,
  };
}

/** Compose the UI-friendly metrics object from raw repo signals. */
export function composeRecoveryMetrics(
  signals: RecoveryMetricsSignals,
  windowDays: number,
  assumptions: ValueAssumptions = DEFAULT_VALUE_ASSUMPTIONS,
): RecoveryMetrics {
  const successRate = computeSuccessRate(signals.runStatusCounts);
  const mttr = computeMttr(signals.mttrDurations);
  const p95Latency = computeLatency(signals.p95LatencyMs);
  const approvalsPending = computeApprovals(signals.approvalsPending);
  const replayRate = computeReplayRate(signals.replayOutcomes);
  const costThisWindow = computeCost(signals.costByProvider, windowDays);
  const clustersResolved = computeClustersResolved(signals.resolvedClusters);
  const slaAttainment = computeSlaAttainment(signals.slaAttainment);
  const valueEstimate = estimateValueSavings(
    signals.resolvedClusters.totalClusters,
    mttr.value != null ? Math.round(mttr.value / 1000) : null,
    assumptions,
  );
  const terminalRuns =
    signals.runStatusCounts.succeeded +
    signals.runStatusCounts.failed +
    signals.runStatusCounts.cancelled;

  return {
    successRate,
    mttr,
    p95Latency,
    approvalsPending,
    replayRate,
    costThisWindow,
    clustersResolved,
    slaAttainment,
    valueEstimate,
    windowDays,
    terminalRuns,
  };
}

/**
 * SLA attainment = share of recovery items resolved in the window that closed
 * before their `slaTargetAt` deadline. `neutral` (no chip colour) when nothing
 * resolved in the window — attainment of an empty set is not "0%".
 */
function computeSlaAttainment(
  counts: SlaAttainmentCounts,
): RecoveryMetric & { resolvedInWindow: number; metSla: number } {
  const { resolvedInWindow, metSla } = counts;
  if (resolvedInWindow === 0) {
    return {
      value: null,
      display: "—",
      severity: "neutral",
      rationale: "No recovery items resolved in this window yet.",
      rationaleCode: "sla_attainment.empty",
      resolvedInWindow,
      metSla,
    };
  }
  const rate = (metSla / resolvedInWindow) * 100;
  const severity: MetricSeverity = rate >= SLA_ATTAINMENT_BANDS.healthy
    ? "healthy"
    : rate >= SLA_ATTAINMENT_BANDS.warn ? "warn" : "unhealthy";
  return {
    value: rate,
    display: `${rate.toFixed(1)}%`,
    severity,
    rationale: `${metSla} of ${resolvedInWindow} resolved within SLA.`,
    rationaleCode: "sla_attainment.summary",
    rationaleMeta: { metSla, resolvedInWindow },
    resolvedInWindow,
    metSla,
  };
}

function computeClustersResolved(
  counts: ResolvedClustersCounts,
): RecoveryMetric & { totalEntries: number; capped: boolean } {
  const total = counts.totalClusters;
  const display = counts.capped ? `≥ ${total} clusters` : `${total} ${total === 1 ? "cluster" : "clusters"}`;
  if (total === 0) {
    return {
      value: 0,
      display: "0 clusters",
      severity: "neutral",
      rationale: "No failure clusters resolved in this window.",
      rationaleCode: "clusters_resolved.empty",
      totalEntries: counts.totalEntries,
      capped: counts.capped,
    };
  }
  return {
    value: total,
    display,
    severity: "healthy",
    rationale: `${total} distinct failure ${total === 1 ? "signature" : "signatures"} resolved (${counts.totalEntries} ${counts.totalEntries === 1 ? "entry" : "entries"}).`,
    rationaleCode: "clusters_resolved.summary",
    rationaleMeta: {
      distinctSignatures: total,
      totalEntries: counts.totalEntries,
      capped: counts.capped,
    },
    totalEntries: counts.totalEntries,
    capped: counts.capped,
  };
}

/* ------------------------------ Per-metric ------------------------------ */

function computeSuccessRate(counts: RunStatusCounts): RecoveryMetric {
  const terminal = counts.succeeded + counts.failed + counts.cancelled;
  if (terminal === 0) {
    return {
      value: null,
      display: "—",
      severity: "neutral",
      rationale: "No terminal runs in the window yet.",
      rationaleCode: "success_rate.empty",
    };
  }
  const rate = (counts.succeeded / terminal) * 100;
  const severity: MetricSeverity = rate >= SUCCESS_RATE_BANDS.healthy
    ? "healthy"
    : rate >= SUCCESS_RATE_BANDS.warn ? "warn" : "unhealthy";
  return {
    value: rate,
    display: `${rate.toFixed(1)}%`,
    severity,
    rationale: `${counts.succeeded} of ${terminal} terminal runs succeeded.`,
    rationaleCode: "success_rate.summary",
    rationaleMeta: { succeeded: counts.succeeded, terminal },
  };
}

/**
 * Index into an ASCENDING-sorted, NON-EMPTY array for the nearest-rank
 * percentile. `fraction` is in (0, 1] (0.5 = median, 0.95 = p95). The result is
 * clamped to [0, length - 1] so a fraction of 1 maps to the last element and
 * rounding can never overshoot the bounds. Both the p50 and p95 reported by
 * `computeMttr` route through this single formula so the two percentiles can
 * never drift to different index conventions for the same input.
 */
function nearestRankIndex(length: number, fraction: number): number {
  return Math.min(Math.max(0, Math.ceil(length * fraction) - 1), length - 1);
}

function computeMttr(durations: number[]): RecoveryMetric {
  if (durations.length === 0) {
    return {
      value: null,
      display: "—",
      severity: "neutral",
      rationale: "No replays in the window — fallback when there's nothing to recover from.",
      rationaleCode: "mttr.empty",
    };
  }
  const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[nearestRankIndex(sorted.length, 0.5)];
  const p95 = sorted[nearestRankIndex(sorted.length, 0.95)];
  const severity: MetricSeverity = avg <= MTTR_BANDS_MS.healthy
    ? "healthy"
    : avg <= MTTR_BANDS_MS.warn ? "warn" : "unhealthy";
  return {
    value: avg,
    display: formatDurationMs(avg),
    severity,
    rationale: `Avg ${formatDurationMs(avg)} across ${durations.length} replay${durations.length === 1 ? "" : "s"} · p50 ${formatDurationMs(p50)} · p95 ${formatDurationMs(p95)}.`,
    rationaleCode: "mttr.summary",
    rationaleMeta: {
      avg: formatDurationMs(avg),
      count: durations.length,
      p50: formatDurationMs(p50),
      p95: formatDurationMs(p95),
    },
  };
}

function computeLatency(p95Ms: number | null): RecoveryMetric {
  if (p95Ms === null) {
    return {
      value: null,
      display: "—",
      severity: "neutral",
      rationale: "Need at least 5 runs in the window to surface a stable p95.",
      rationaleCode: "latency.insufficient",
    };
  }
  const severity: MetricSeverity = p95Ms <= LATENCY_BANDS_MS.healthy
    ? "healthy"
    : p95Ms <= LATENCY_BANDS_MS.warn ? "warn" : "unhealthy";
  return {
    value: p95Ms,
    display: formatDurationMs(p95Ms),
    severity,
    rationale: "p95 across all runs in the window.",
    rationaleCode: "latency.summary",
  };
}

function computeApprovals(count: number): RecoveryMetric {
  const severity: MetricSeverity = count === 0
    ? "healthy"
    : count <= APPROVALS_BANDS.neutralMax ? "neutral" : "warn";
  // Approvals is the only current-state metric in the rollup — every
  // other metric reflects the rolling window, but "what's blocked right
  // now" only makes sense as a snapshot. Surface that explicitly so the
  // UI's window header doesn't mislead operators.
  return {
    value: count,
    display: String(count),
    severity,
    rationale: count === 0
      ? "Current state: no human approvals are blocking a run right now."
      : `Current state: ${count} run${count === 1 ? "" : "s"} paused at an approval node — independent of the window.`,
    rationaleCode: count === 0 ? "approvals.none" : "approvals.blocked",
    rationaleMeta: { count },
  };
}

function computeReplayRate(replay: ReplayOutcomeCounts): RecoveryMetric {
  const denom = replay.replayedSuccess + replay.replayedAndReopened;
  if (denom === 0) {
    return {
      value: null,
      display: "—",
      severity: "neutral",
      rationale: "No replay attempts in the window yet.",
      rationaleCode: "replay.empty",
    };
  }
  const rate = (replay.replayedSuccess / denom) * 100;
  const severity: MetricSeverity = rate >= REPLAY_RATE_BANDS.healthy
    ? "healthy"
    : rate >= REPLAY_RATE_BANDS.warn ? "warn" : "unhealthy";
  return {
    value: rate,
    display: `${rate.toFixed(1)}%`,
    severity,
    rationale: `${replay.replayedSuccess} replay${replay.replayedSuccess === 1 ? "" : "s"} succeeded · ${replay.replayedAndReopened} re-failed.`,
    rationaleCode: "replay.summary",
    rationaleMeta: {
      replayedSuccess: replay.replayedSuccess,
      replayedAndReopened: replay.replayedAndReopened,
    },
  };
}

function computeCost(
  rows: CostProviderRow[],
  windowDays: number,
): RecoveryMetric & { providers: CostProviderRow[] } {
  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  const providers = rows
    .map((row) => ({ ...row, provider: displayProvider(row.provider) }))
    .sort((a, b) => b.usd - a.usd);
  return {
    value: total,
    display: `$${total.toFixed(2)}`,
    severity: "neutral",
    rationale: `Across ${providers.length} provider${providers.length === 1 ? "" : "s"} over the last ${windowDays} day${windowDays === 1 ? "" : "s"}.`,
    rationaleCode: "cost.summary",
    rationaleMeta: { providerCount: providers.length, windowDays },
    providers,
  };
}

/* ----------------------------- Formatting -------------------------------- */

/** Human-friendly duration: "1.4s" / "3m 12s" / "1h 5m". */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}
