/** Bounded recovery dashboard and time-series signal queries. */

import {
  db,
  deadLetters,
  recoveryImpactEvents,
  runEvents,
  runNodes,
  runs,
} from "@janusly/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { queryFailureClustersResolved } from "./clusters";
import {
  COST_BREAKDOWN_GROUP_CAP,
  COST_BREAKDOWN_OTHER_KEY,
  DEFAULT_WINDOW_DAYS,
  EVENT_ROW_CAP,
  HEATMAP_MAX_DAYS,
  MTTR_SAMPLE_CAP,
  RUN_STATUS_ROW_CAP,
  type CostProviderRowRepo,
  type MttrTrendPointRepo,
  type RecoveryHeatmapDay,
  type RecoveryMetricsSignals,
  type ReplayOutcomeCountsRepo,
  type RunStatusCountsRepo,
  type VerifiedRecoveryStatsRepo,
} from "./contracts";
import {
  queryRecoveryRecurrence,
  queryRecoverySlaAttainment,
  queryTimeToFirstAction,
} from "./effectiveness";

/** Collect raw recovery-metrics signals for one org over a rolling window. */
export async function queryRecoveryMetricsSignals(
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<RecoveryMetricsSignals> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    runStatusCounts,
    verifiedRecovery,
    mttrDurations,
    mttrTrend,
    approvalsPending,
    costByProvider,
    p95LatencyMs,
    replayOutcomes,
    resolvedClusters,
    slaAttainment,
    timeToFirstAction,
    recurrence,
  ] = await Promise.all([
    queryRunStatusCounts(orgId, since),
    queryVerifiedRecoveryStats(orgId, since),
    queryMttrDurations(orgId, since),
    queryMttrTrend(orgId, since),
    queryApprovalsPending(orgId),
    queryCostByProvider(orgId, since),
    queryP95Latency(orgId, since),
    queryReplayOutcomes(orgId, since),
    queryFailureClustersResolved(orgId, since),
    queryRecoverySlaAttainment(orgId, since),
    queryTimeToFirstAction(orgId, since),
    queryRecoveryRecurrence(orgId, since),
  ]);

  return {
    runStatusCounts,
    verifiedRecovery,
    mttrDurations,
    mttrTrend,
    approvalsPending,
    costByProvider,
    p95LatencyMs,
    replayOutcomes,
    resolvedClusters,
    slaAttainment,
    timeToFirstAction,
    recurrence,
  };
}

/**
 * Per-day median terminal recovery impact, bucketed by the day success
 * committed. Aggregated entirely
 * in Postgres (one GROUP BY, no row materialization) and bounded to the most
 * recent 14 days with data, returned oldest-first for the recovery trend.
 * Multi-tenant scope: `eq(recoveryImpactEvents.orgId, orgId)`.
 */
async function queryMttrTrend(orgId: string, since: Date): Promise<MttrTrendPointRepo[]> {
  const dayBucket = sql`date_trunc('day', ${recoveryImpactEvents.recoveredAt})`;
  const rows = await db
    .select({
      day: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
      seconds: sql<number>`percentile_cont(0.5) within group (order by ${recoveryImpactEvents.downtimeEndedMs})::float8 / 1000`,
    })
    .from(recoveryImpactEvents)
    .innerJoin(
      runs,
      and(
        eq(runs.id, recoveryImpactEvents.runId),
        eq(runs.orgId, recoveryImpactEvents.orgId),
      ),
    )
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
      isNull(runs.replayMode),
    ))
    .groupBy(dayBucket)
    .orderBy(sql`${dayBucket} desc`)
    .limit(14);

  // Newest-first from SQL → reverse to ascending for the left-to-right
  // sparkline; negative clocks are rejected before impact insertion, while a
  // zero-duration recovery remains a valid sample at timestamp precision.
  return rows
    .map((row) => ({ day: row.day, seconds: Number(row.seconds) }))
    .filter((point) => Number.isFinite(point.seconds) && point.seconds >= 0)
    .reverse();
}

/** One per-day cell for the recovery heatmap calendar. */

/**
 * Per-day failure/recovery counts over the last `days` (clamped 1..90),
 * bucketed by the day the failure landed: `failures` = dead letters created
 * that day, `recovered` = the subset with terminal impact evidence,
 * `mttrSeconds` = median terminal recovery time. One Postgres GROUP BY,
 * oldest-first. Multi-tenant scope: `eq(deadLetters.orgId, orgId)`. The existing
 * `dead_letters_org_created_id_idx` covers the window scan.
 */
export async function queryRecoveryHeatmap(orgId: string, days: number): Promise<RecoveryHeatmapDay[]> {
  const windowDays = Math.min(HEATMAP_MAX_DAYS, Math.max(1, Math.floor(days)));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const dayBucket = sql`date_trunc('day', ${deadLetters.createdAt})`;
  const rows = await db
    .select({
      day: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
      failures: sql<number>`count(*)::int`,
      recovered: sql<number>`count(${recoveryImpactEvents.deadLetterId})::int`,
      mttrSeconds: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${recoveryImpactEvents.downtimeEndedMs}), 0)::float8 / 1000`,
    })
    .from(deadLetters)
    .innerJoin(
      runs,
      and(
        eq(runs.id, deadLetters.runId),
        eq(runs.orgId, deadLetters.orgId),
      ),
    )
    .leftJoin(
      recoveryImpactEvents,
      and(
        eq(recoveryImpactEvents.deadLetterId, deadLetters.id),
        eq(recoveryImpactEvents.orgId, deadLetters.orgId),
      ),
    )
    .where(and(
      eq(deadLetters.orgId, orgId),
      gte(deadLetters.createdAt, since),
      isNull(runs.replayMode),
    ))
    .groupBy(dayBucket)
    .orderBy(sql`${dayBucket} asc`)
    .limit(HEATMAP_MAX_DAYS);
  return rows.map((row) => ({
    day: row.day,
    failures: Number(row.failures),
    recovered: Number(row.recovered),
    mttrSeconds: Math.round(Number(row.mttrSeconds)),
  }));
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
      isNull(runs.replayMode),
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

/**
 * Exact rolling-window north-star aggregate. PostgreSQL computes the complete
 * production sample and returns one bounded row; the separate raw duration
 * query remains capped only for the legacy arithmetic-average `mttr` field.
 */
async function queryVerifiedRecoveryStats(
  orgId: string,
  since: Date,
): Promise<VerifiedRecoveryStatsRepo> {
  const rows = await db
    .select({
      sampleSize: sql<number>`count(*)::int`,
      p50Ms: sql<number | null>`percentile_cont(0.5) within group (order by ${recoveryImpactEvents.downtimeEndedMs})`,
      p90Ms: sql<number | null>`percentile_cont(0.9) within group (order by ${recoveryImpactEvents.downtimeEndedMs})`,
      downtimeEndedMs: sql<number>`coalesce(sum(${recoveryImpactEvents.downtimeEndedMs}), 0)`,
    })
    .from(recoveryImpactEvents)
    .innerJoin(
      runs,
      and(
        eq(runs.id, recoveryImpactEvents.runId),
        eq(runs.orgId, recoveryImpactEvents.orgId),
      ),
    )
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
      isNull(runs.replayMode),
    ));
  const row = rows[0];
  const sampleSize = Number(row?.sampleSize ?? 0);
  const p50Ms = row?.p50Ms == null ? null : Number(row.p50Ms);
  const p90Ms = row?.p90Ms == null ? null : Number(row.p90Ms);
  const downtimeEndedMs = Number(row?.downtimeEndedMs ?? 0);
  return {
    sampleSize: Number.isFinite(sampleSize)
      ? Math.max(0, Math.floor(sampleSize))
      : 0,
    p50Ms: p50Ms != null && Number.isFinite(p50Ms)
      ? Math.max(0, Math.round(p50Ms))
      : null,
    p90Ms: p90Ms != null && Number.isFinite(p90Ms)
      ? Math.max(0, Math.round(p90Ms))
      : null,
    downtimeEndedMs: Number.isFinite(downtimeEndedMs)
      ? Math.max(0, Math.round(downtimeEndedMs))
      : 0,
  };
}

async function queryMttrDurations(orgId: string, since: Date): Promise<number[]> {
  // Terminal recovery duration is materialized atomically with node success.
  // Enqueue acceptance (`dead_letters.status='replayed'`) is not evidence.
  const rows = await db
    .select({
      downtimeEndedMs: recoveryImpactEvents.downtimeEndedMs,
    })
    .from(recoveryImpactEvents)
    .innerJoin(
      runs,
      and(
        eq(runs.id, recoveryImpactEvents.runId),
        eq(runs.orgId, recoveryImpactEvents.orgId),
      ),
    )
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
      isNull(runs.replayMode),
    ))
    .limit(MTTR_SAMPLE_CAP);

  return rows
    .map((row) => Number(row.downtimeEndedMs))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
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
      isNull(runs.replayMode),
      sql`${runNodes.stateJson} #>> '{waiting,reason}' = 'Waiting for human approval'`,
    ));
  return rows[0]?.count ?? 0;
}

async function queryCostByProvider(orgId: string, since: Date): Promise<CostProviderRowRepo[]> {
  // Aggregate the complete rolling-window predicate in Postgres. A raw-row
  // cap would make totals arbitrary, while returning every distinct free-form
  // model override would leave response cardinality unbounded. The CTE ranks
  // complete groups by operator value and folds every group after the first
  // 100 into one explicit `aggregated` bucket; totals remain exact.
  const sinceIso = since.toISOString();
  const rows = await db.execute<{
    provider: string;
    model: string;
    usd: number;
    tokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    calls: number;
    aggregated: boolean;
  }>(sql`
    WITH grouped AS (
      SELECT
        CASE
          WHEN jsonb_typeof("metadata"->'provider') = 'string'
            THEN left(coalesce(nullif(trim("metadata"->>'provider'), ''), 'unknown'), 80)
          ELSE 'unknown'
        END AS "provider",
        CASE
          WHEN jsonb_typeof("metadata"->'model') = 'string'
            THEN left(coalesce(nullif(trim("metadata"->>'model'), ''), 'unknown'), 160)
          ELSE 'unknown'
        END AS "model",
        sum(CASE
          WHEN jsonb_typeof("metadata"->'costUsd') = 'number'
            THEN greatest(("metadata"->>'costUsd')::double precision, 0)
          ELSE 0
        END)::double precision AS "usd",
        sum(greatest("quantity", 0))::double precision AS "tokens",
        sum(CASE
          WHEN jsonb_typeof("metadata"->'inputTokens') = 'number'
            THEN greatest(("metadata"->>'inputTokens')::double precision, 0)
          ELSE 0
        END)::double precision AS "inputTokens",
        sum(CASE
          WHEN jsonb_typeof("metadata"->'cachedInputTokens') = 'number'
            THEN greatest(("metadata"->>'cachedInputTokens')::double precision, 0)
          ELSE 0
        END)::double precision AS "cachedInputTokens",
        sum(CASE
          WHEN jsonb_typeof("metadata"->'cacheCreationInputTokens') = 'number'
            THEN greatest(("metadata"->>'cacheCreationInputTokens')::double precision, 0)
          ELSE 0
        END)::double precision AS "cacheCreationInputTokens",
        count(*)::double precision AS "calls"
      FROM "usage_events"
      WHERE "org_id" = ${orgId}
        AND "metric" = 'llm.completion'
        AND "created_at" >= ${sinceIso}::timestamptz
      GROUP BY 1, 2
    ), ranked AS (
      SELECT
        grouped.*,
        row_number() OVER (
          ORDER BY "usd" DESC, "tokens" DESC, "provider", "model"
        ) AS "groupRank"
      FROM grouped
    ), bucketed AS (
      SELECT
        CASE WHEN "groupRank" <= ${COST_BREAKDOWN_GROUP_CAP}
          THEN "provider" ELSE ${COST_BREAKDOWN_OTHER_KEY} END AS "provider",
        CASE WHEN "groupRank" <= ${COST_BREAKDOWN_GROUP_CAP}
          THEN "model" ELSE ${COST_BREAKDOWN_OTHER_KEY} END AS "model",
        "groupRank" > ${COST_BREAKDOWN_GROUP_CAP} AS "aggregated",
        "usd",
        "tokens",
        "inputTokens",
        "cachedInputTokens",
        "cacheCreationInputTokens",
        "calls"
      FROM ranked
    )
    SELECT
      "provider",
      "model",
      sum("usd")::double precision AS "usd",
      sum("tokens")::double precision AS "tokens",
      sum("inputTokens")::double precision AS "inputTokens",
      sum("cachedInputTokens")::double precision AS "cachedInputTokens",
      sum("cacheCreationInputTokens")::double precision AS "cacheCreationInputTokens",
      sum("calls")::double precision AS "calls",
      "aggregated"
    FROM bucketed
    GROUP BY "aggregated", "provider", "model"
    ORDER BY "aggregated", "usd" DESC, "tokens" DESC, "provider", "model"
  `);

  const readNonNegativeNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    usd: readNonNegativeNumber(row.usd),
    tokens: readNonNegativeNumber(row.tokens),
    inputTokens: readNonNegativeNumber(row.inputTokens),
    cachedInputTokens: readNonNegativeNumber(row.cachedInputTokens),
    cacheCreationInputTokens: readNonNegativeNumber(row.cacheCreationInputTokens),
    calls: readNonNegativeNumber(row.calls),
    aggregated: row.aggregated === true,
  }));
}

async function queryP95Latency(orgId: string, since: Date): Promise<number | null> {
  // Aggregate first→last timestamp per run IN POSTGRES (one row per run, not
  // one per event) so the p95 sample is ~#runs and never suffers the prior
  // per-run truncation bias from capping at EVENT_ROW_CAP raw events. The cap
  // now bounds grouped runs. runs.orgId keeps ad-hoc executions in the
  // org-level denominator; the (run_id, created_at) index supports the GROUP BY.
  const rows = await db
    .select({
      firstAt: sql<string>`min(${runEvents.createdAt})`,
      lastAt: sql<string>`max(${runEvents.createdAt})`,
    })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .where(and(
      eq(runs.orgId, orgId),
      gte(runs.createdAt, since),
      isNull(runs.replayMode),
    ))
    .groupBy(runEvents.runId)
    .limit(EVENT_ROW_CAP);

  const durations = rows
    .map((row) => new Date(row.lastAt).getTime() - new Date(row.firstAt).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (durations.length < 5) return null;
  durations.sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  return durations[Math.min(index, durations.length - 1)];
}

async function queryReplayOutcomes(orgId: string, since: Date): Promise<ReplayOutcomeCountsRepo> {
  // Count only terminally observed outcomes. A replay is successful when its
  // immutable impact event exists; it re-failed when a later DLQ row exists
  // for the same run/node. In-flight attempts are excluded from both sides of
  // the rate instead of being mislabeled as failures.
  // Raw `sql` parameters bypass Drizzle's timestamp column encoder. Pass ISO
  // text with an explicit cast so postgres-js never receives a JavaScript Date
  // for a timestamptz bind (which it cannot serialize on this path).
  const sinceIso = since.toISOString();
  const rows = await db.execute<{
    replayed_success: number;
    replayed_and_reopened: number;
  }>(sql`
    WITH attempts AS (
      SELECT
        dlq."id",
        dlq."org_id",
        dlq."run_id",
        dlq."node_id",
        coalesce(dlq."replay_claimed_at", dlq."replayed_at") AS "replay_boundary"
      FROM "dead_letters" dlq
      INNER JOIN "runs" attempt_run
        ON attempt_run."id" = dlq."run_id"
       AND attempt_run."org_id" = dlq."org_id"
      WHERE dlq."org_id" = ${orgId}
        AND coalesce(dlq."replay_claimed_at", dlq."replayed_at") >= ${sinceIso}::timestamptz
        AND attempt_run."replay_mode" IS NULL
    ), outcomes AS (
      SELECT
        attempts."id",
        bool_or(impact."dead_letter_id" IS NOT NULL) AS "succeeded",
        bool_or(later_run."id" IS NOT NULL) AS "reopened"
      FROM attempts
      LEFT JOIN "recovery_impact_events" impact
        ON impact."dead_letter_id" = attempts."id"
      LEFT JOIN "dead_letters" later
        ON later."org_id" = attempts."org_id"
       AND later."run_id" = attempts."run_id"
       AND later."node_id" = attempts."node_id"
       AND later."id" <> attempts."id"
       AND later."created_at" > attempts."replay_boundary"
      LEFT JOIN "runs" later_run
        ON later_run."id" = later."run_id"
       AND later_run."org_id" = later."org_id"
       AND later_run."replay_mode" IS NULL
      GROUP BY attempts."id"
    )
    SELECT
      count(*) FILTER (WHERE "succeeded")::int AS "replayed_success",
      count(*) FILTER (WHERE NOT "succeeded" AND "reopened")::int AS "replayed_and_reopened"
    FROM outcomes
  `);
  const replayedSuccess = Number(rows[0]?.replayed_success ?? 0);
  const replayedAndReopened = Number(rows[0]?.replayed_and_reopened ?? 0);
  return {
    totalEntries: replayedSuccess + replayedAndReopened,
    replayedSuccess,
    replayedAndReopened,
  };
}
