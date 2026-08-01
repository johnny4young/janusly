/** Shared contracts and bounds for recovery metrics repositories. */

export const DEFAULT_WINDOW_DAYS = 30;
export const RUN_STATUS_ROW_CAP = 10_000;
export const MTTR_SAMPLE_CAP = 1_000;
export const EVENT_ROW_CAP = 5_000;
export const RESOLVED_CLUSTERS_ROW_CAP = 10_000;
export const HEATMAP_MAX_DAYS = 90;
export const COST_BREAKDOWN_GROUP_CAP = 100;
export const COST_BREAKDOWN_OTHER_KEY = "__other__";

export type RunStatusCountsRepo = {
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  total: number;
};

export type CostProviderRowRepo = {
  provider: string;
  model: string;
  usd: number;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  calls: number;
  aggregated: boolean;
};

export type ReplayOutcomeCountsRepo = {
  totalEntries: number;
  replayedSuccess: number;
  replayedAndReopened: number;
};

/**
 * Per-window count of distinct failure signatures whose replay reached
 * terminal node success. Drives the Value Dashboard's
 * "clusters resolved" metric + the hours-saved / dollars-saved estimate.
 *
 * `totalEntries` is the raw row count (informational, surfaced as
 * "M entries across N distinct signatures" in the UI). `totalClusters`
 * is the distinct count and is the load-bearing input to the estimate
 * formula.
 *
 * When the scan hits the row cap, `capped: true` and the UI renders
 * `>= cap` instead of an exact count — the same pattern other queries
 * here use.
 */
export type ResolvedClustersRepo = {
  totalClusters: number;
  totalEntries: number;
  capped: boolean;
};

/**
 * SLA-attainment counts over recovery items RESOLVED in the window. `metSla`
 * is the subset whose `resolvedAt <= slaTargetAt` (closed before the SLA
 * deadline). The rollup renders `metSla / resolvedInWindow` as an attainment
 * percentage. Open-but-breached items are intentionally excluded — attainment
 * measures resolved-within-target; live breaches are the alert surface.
 */
export type SlaAttainmentRepo = {
  resolvedInWindow: number;
  metSla: number;
};

/** Set-once first-action latency over recovery incidents and untracked DLQ replays. */
export type TimeToFirstActionRepo = {
  avgSeconds: number | null;
  p95Seconds: number | null;
  sampleSize: number;
};

/** Successful fixes evaluated for a same-signature production recurrence within seven days. */
export type RecoveryRecurrenceRepo = {
  resolved: number;
  recurred: number;
  recurredSignatures: string[];
};

/**
 * Raw signals consumed by the engine's `composeRecoveryMetrics`. Field
 * names + shape match `RecoveryMetricsSignals` there — both modules
 * declare the type so neither layer has to depend on the other.
 */
/** One per-day point for the recovery trend: `day` = `YYYY-MM-DD`, `seconds` = median verified-recovery time. */
export type MttrTrendPointRepo = { day: string; seconds: number };

export type VerifiedRecoveryStatsRepo = {
  sampleSize: number;
  p50Ms: number | null;
  p90Ms: number | null;
  downtimeEndedMs: number;
};

export type RecoveryMetricsSignals = {
  runStatusCounts: RunStatusCountsRepo;
  verifiedRecovery: VerifiedRecoveryStatsRepo;
  mttrDurations: number[];
  mttrTrend: MttrTrendPointRepo[];
  approvalsPending: number;
  costByProvider: CostProviderRowRepo[];
  p95LatencyMs: number | null;
  replayOutcomes: ReplayOutcomeCountsRepo;
  resolvedClusters: ResolvedClustersRepo;
  slaAttainment: SlaAttainmentRepo;
  timeToFirstAction: TimeToFirstActionRepo;
  recurrence: RecoveryRecurrenceRepo;
};

/** Lifetime measured value from DLQ replays that reached terminal success. */
export type RecoveryLedgerRepo = {
  totalRecovered: number;
  downtimeEndedMs: number;
  sinceIso: string | null;
};

export type RecoveryImpactCompletion = {
  deadLetterId: string | null;
  userId: string | null;
  playbookId?: string | null;
  validationRunId?: string | null;
  runId: string;
  nodeId: string;
  recoveredAt: Date;
};

export type RecoveryHeatmapDay = {
  day: string;
  failures: number;
  recovered: number;
  mttrSeconds: number;
};
