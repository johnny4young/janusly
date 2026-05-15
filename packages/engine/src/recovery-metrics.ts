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
 * I/O, no DB, no network. Used by `apps/api/src/index.ts:GET
 * /recovery/metrics`.
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
  | "cost.summary";

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

/** Raw signals the data repo returns; the rollup converts to `RecoveryMetrics`. */
export type RecoveryMetricsSignals = {
  runStatusCounts: RunStatusCounts;
  /** Recovery durations (ms) for replayed DLQ rows. */
  mttrDurations: number[];
  approvalsPending: number;
  costByProvider: CostProviderRow[];
  p95LatencyMs: number | null;
  replayOutcomes: ReplayOutcomeCounts;
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

/** Full UI-friendly rollup returned by `composeRecoveryMetrics`. */
export type RecoveryMetrics = {
  successRate: RecoveryMetric;
  mttr: RecoveryMetric;
  p95Latency: RecoveryMetric;
  approvalsPending: RecoveryMetric;
  replayRate: RecoveryMetric;
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[] };
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

/** Compose the UI-friendly metrics object from raw repo signals. */
export function composeRecoveryMetrics(
  signals: RecoveryMetricsSignals,
  windowDays: number,
): RecoveryMetrics {
  const successRate = computeSuccessRate(signals.runStatusCounts);
  const mttr = computeMttr(signals.mttrDurations);
  const p95Latency = computeLatency(signals.p95LatencyMs);
  const approvalsPending = computeApprovals(signals.approvalsPending);
  const replayRate = computeReplayRate(signals.replayOutcomes);
  const costThisWindow = computeCost(signals.costByProvider, windowDays);
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
    windowDays,
    terminalRuns,
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
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[Math.min(p95Index, sorted.length - 1)];
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
