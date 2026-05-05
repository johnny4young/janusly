/**
 * Repository for the org-level recovery metrics dashboard. Six parallel
 * windowed queries that the engine layer (`composeRecoveryMetrics` in
 * `@janusly/engine`) rolls up into the UI-friendly shape rendered by
 * `OperationsPanel.tsx`.
 *
 * Used by `apps/api/src/index.ts:GET /recovery/metrics`.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries an org-scoped predicate
 *   (`eq(<table>.orgId, orgId)`) — direct on `runs`, `dead_letters`,
 *   and `usage_events`, or via the `run_nodes → runs` join when the table
 *   itself doesn't carry `orgId`.
 * - Window cap: matches the 30-day convention used elsewhere
 *   (`workflowHealthRepo`, `getUsageSummary`). Don't unbound the scan.
 * - Per-query caps: 1k MTTR samples, 10k usage rows, 5k events. Cluster
 *   computation degrades gracefully when an org's row counts grow; for
 *   true scale move to pre-aggregated tables.
 *
 * Note on the cross-module type shape: `RecoveryMetricsSignals` lives in
 * `@janusly/engine/src/recovery-metrics.ts` (the engine is a higher
 * layer than data; data must not import from engine). This module
 * re-declares the shape locally and the API wires repo → engine through
 * structural typing.
 */

import { db } from "@janusly/db";
import { deadLetters, runEvents, runNodes, runs, usageEvents } from "@janusly/db";
import { and, asc, eq, gte, isNotNull, sql } from "drizzle-orm";

const DEFAULT_WINDOW_DAYS = 30;
const RUN_STATUS_ROW_CAP = 10_000;
const MTTR_SAMPLE_CAP = 1_000;
const USAGE_ROW_CAP = 10_000;
const EVENT_ROW_CAP = 5_000;

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
  calls: number;
};

export type ReplayOutcomeCountsRepo = {
  totalEntries: number;
  replayedSuccess: number;
  replayedAndReopened: number;
};

/**
 * Raw signals consumed by the engine's `composeRecoveryMetrics`. Field
 * names + shape match `RecoveryMetricsSignals` there — both modules
 * declare the type so neither layer has to depend on the other.
 */
export type RecoveryMetricsSignals = {
  runStatusCounts: RunStatusCountsRepo;
  mttrDurations: number[];
  approvalsPending: number;
  costByProvider: CostProviderRowRepo[];
  p95LatencyMs: number | null;
  replayOutcomes: ReplayOutcomeCountsRepo;
};

/** Collect raw recovery-metrics signals for one org over a rolling window. */
export async function collectRecoveryMetricsSignals(
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<RecoveryMetricsSignals> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    runStatusCounts,
    mttrDurations,
    approvalsPending,
    costByProvider,
    p95LatencyMs,
    replayOutcomes,
  ] = await Promise.all([
    queryRunStatusCounts(orgId, since),
    queryMttrDurations(orgId, since),
    queryApprovalsPending(orgId),
    queryCostByProvider(orgId, since),
    queryP95Latency(orgId, since),
    queryReplayOutcomes(orgId, since),
  ]);

  return {
    runStatusCounts,
    mttrDurations,
    approvalsPending,
    costByProvider,
    p95LatencyMs,
    replayOutcomes,
  };
}

async function queryRunStatusCounts(orgId: string, since: Date): Promise<RunStatusCountsRepo> {
  // Group runs by status with multi-tenant scope via runs.orgId. Do not
  // join through workflow_versions here: ad-hoc runs deliberately store
  // workflowVersionId as the workflow id / run id and have no version row.
  // Bounded to RUN_STATUS_ROW_CAP rows so a busy org doesn't OOM the
  // dashboard poll — at the cap the success-rate denominator reflects a
  // sample of the window, not the entire window. Pre-aggregated tables
  // are the right fix when an org genuinely needs full-window precision.
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(and(
      eq(runs.orgId, orgId),
      gte(runs.createdAt, since),
    ))
    .limit(RUN_STATUS_ROW_CAP);

  const counts: RunStatusCountsRepo = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    queued: 0,
    total: rows.length,
  };
  for (const row of rows) {
    if (row.status === "succeeded") counts.succeeded += 1;
    else if (row.status === "failed") counts.failed += 1;
    else if (row.status === "cancelled") counts.cancelled += 1;
    else if (row.status === "running") counts.running += 1;
    else if (row.status === "queued") counts.queued += 1;
  }
  return counts;
}

async function queryMttrDurations(orgId: string, since: Date): Promise<number[]> {
  // Replay duration in ms for DLQ rows that recovered cleanly via
  // `/dlq/replay`. Skip `status='resolved'` — those were closed by the
  // operator without a replay (fix-by-other-means isn't a recovery time).
  const rows = await db
    .select({
      createdAt: deadLetters.createdAt,
      replayedAt: deadLetters.replayedAt,
    })
    .from(deadLetters)
    .where(and(
      eq(deadLetters.orgId, orgId),
      eq(deadLetters.status, "replayed"),
      gte(deadLetters.createdAt, since),
    ))
    .limit(MTTR_SAMPLE_CAP);

  const durations: number[] = [];
  for (const row of rows) {
    if (!row.createdAt || !row.replayedAt) continue;
    const ms = row.replayedAt.getTime() - row.createdAt.getTime();
    if (ms > 0) durations.push(ms);
  }
  return durations;
}

async function queryApprovalsPending(orgId: string): Promise<number> {
  // Current-state count, not windowed — operators read this as "right
  // now blocking" not "historical". Multi-tenant scope flows through
  // runs.orgId rather than workflow_versions because run_nodes joins
  // most cheaply on runs.id.
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runNodes)
    .innerJoin(runs, eq(runs.id, runNodes.runId))
    .where(and(
      eq(runs.orgId, orgId),
      eq(runNodes.status, "waiting"),
      sql`${runNodes.stateJson} #>> '{waiting,reason}' = 'Waiting for human approval'`,
    ));
  return rows[0]?.count ?? 0;
}

async function queryCostByProvider(orgId: string, since: Date): Promise<CostProviderRowRepo[]> {
  // Pull raw rows for `metric: "llm.completion"` (the chokepoint
  // metric); group by (provider, model) in JS rather than via Postgres
  // JSON ops — keeps the query plan identical to other repos and
  // microsecond-cheap at the 10k cap.
  const rows = await db
    .select({
      quantity: usageEvents.quantity,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.orgId, orgId),
      eq(usageEvents.metric, "llm.completion"),
      gte(usageEvents.createdAt, since),
    ))
    .limit(USAGE_ROW_CAP);

  const byKey = new Map<string, CostProviderRowRepo>();
  for (const row of rows) {
    const metadata = (row.metadata ?? null) as Record<string, unknown> | null;
    const provider = typeof metadata?.provider === "string" ? metadata.provider : "unknown";
    const model = typeof metadata?.model === "string" ? metadata.model : "unknown";
    const cost = typeof metadata?.costUsd === "number" && Number.isFinite(metadata.costUsd)
      ? metadata.costUsd
      : 0;
    const key = `${provider}::${model}`;
    const acc = byKey.get(key) ?? { provider, model, usd: 0, tokens: 0, calls: 0 };
    acc.usd += cost;
    acc.tokens += row.quantity ?? 0;
    acc.calls += 1;
    byKey.set(key, acc);
  }
  return Array.from(byKey.values());
}

async function queryP95Latency(orgId: string, since: Date): Promise<number | null> {
  // Pull run_events joined through runs for org scope, compute first→last
  // timestamp per run, return p95 via nearest-rank. runs.orgId keeps ad-hoc
  // executions in the org-level denominator.
  const rows = await db
    .select({
      runId: runEvents.runId,
      createdAt: runEvents.createdAt,
    })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .where(and(
      eq(runs.orgId, orgId),
      gte(runs.createdAt, since),
    ))
    .orderBy(asc(runEvents.createdAt))
    .limit(EVENT_ROW_CAP);

  const range = new Map<string, { first: number; last: number }>();
  for (const event of rows) {
    if (!event.createdAt) continue;
    const ts = event.createdAt.getTime();
    const prev = range.get(event.runId);
    if (!prev) range.set(event.runId, { first: ts, last: ts });
    else prev.last = ts;
  }
  const durations = Array.from(range.values())
    .map((entry) => entry.last - entry.first)
    .filter((ms) => ms > 0);
  if (durations.length < 5) return null;
  durations.sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  return durations[Math.min(index, durations.length - 1)];
}

async function queryReplayOutcomes(orgId: string, since: Date): Promise<ReplayOutcomeCountsRepo> {
  // Group replay attempts by status. Never-replayed open DLQ rows must not
  // count as replay failures; only rows with `replayedAt` stamped represent
  // an operator-triggered replay attempt.
  const rows = await db
    .select({
      status: deadLetters.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deadLetters)
    .where(and(
      eq(deadLetters.orgId, orgId),
      gte(deadLetters.createdAt, since),
      isNotNull(deadLetters.replayedAt),
    ))
    .groupBy(deadLetters.status);

  const counts: ReplayOutcomeCountsRepo = {
    totalEntries: 0,
    replayedSuccess: 0,
    replayedAndReopened: 0,
  };
  for (const row of rows) {
    counts.totalEntries += row.count ?? 0;
    if (row.status === "replayed") counts.replayedSuccess += row.count ?? 0;
    else counts.replayedAndReopened += row.count ?? 0;
  }
  return counts;
}
