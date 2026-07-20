/**
 * Repository for org-level recovery metrics and durable impact summaries.
 * Windowed queries feed the engine layer (`composeRecoveryMetrics` in
 * `@janusly/engine`) rolls up into the UI-friendly shape rendered by
 * `OperationsPage.tsx`.
 *
 * Used by `apps/api/src/routes/recovery-routes.ts:GET /recovery/metrics`.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries an org-scoped predicate
 *   (`eq(<table>.orgId, orgId)`) — direct on `runs`, `dead_letters`,
 *   and `usage_events`, or via the `run_nodes → runs` join when the table
 *   itself doesn't carry `orgId`.
 * - Window cap: matches the 30-day convention used elsewhere
 *   (`workflowHealthRepo`, `getUsageSummary`). Don't unbound the scan.
 * - Per-query bounds: 1k MTTR samples and 5k event rows; LLM cost/cache reads
 *   aggregate the complete time-bounded predicate in Postgres, retain the top
 *   100 provider/model groups, and fold the remainder into one explicit row.
 *   For true scale move to pre-aggregated tables.
 *
 * Note on the cross-module type shape: `RecoveryMetricsSignals` lives in
 * `@janusly/engine/src/recovery-metrics.ts` (the engine is a higher
 * layer than data; data must not import from engine). This module
 * re-declares the shape locally and the API wires repo → engine through
 * structural typing.
 */

import { db } from "@janusly/db";
import {
  auditLogs,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  recoveryItemChildren,
  recoveryItems,
  runEvents,
  runNodes,
  runs,
} from "@janusly/db";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";
import { recordRecoveryPlaybookAppliedTx } from "./recoveryPlaybooksRepo";

const DEFAULT_WINDOW_DAYS = 30;
const RUN_STATUS_ROW_CAP = 10_000;
const MTTR_SAMPLE_CAP = 1_000;
const EVENT_ROW_CAP = 5_000;
const RESOLVED_CLUSTERS_ROW_CAP = 10_000;
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
/** One per-day point for the MTTR trend sparkline: `day` = `YYYY-MM-DD`, `seconds` = avg recovery time that day. */
export type MttrTrendPointRepo = { day: string; seconds: number };

export type RecoveryMetricsSignals = {
  runStatusCounts: RunStatusCountsRepo;
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

/**
 * Transaction handle accepted by the node-success persistence path. Keeping
 * impact-event insertion and rollup increment inside the SAME transaction as
 * `run_nodes.status = 'succeeded'` prevents crash gaps and false wins.
 */
type RecoveryImpactTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecoveryImpactCompletion = {
  deadLetterId: string | null;
  userId: string | null;
  playbookId?: string | null;
  validationRunId?: string | null;
  runId: string;
  nodeId: string;
  recoveredAt: Date;
};

/**
 * Record one terminally successful DLQ recovery and increment its tenant's
 * lifetime projection. `dead_letter_id` is unique, so duplicate worker
 * completion attempts are idempotent and never inflate value.
 */
export async function recordRecoveryImpactTx(
  tx: RecoveryImpactTx,
  input: RecoveryImpactCompletion,
): Promise<boolean> {
  if (!input.deadLetterId) return false;

  const [dlq] = await tx
    .select({
      orgId: deadLetters.orgId,
      createdAt: deadLetters.createdAt,
      replayClaimedAt: deadLetters.replayClaimedAt,
      replayedAt: deadLetters.replayedAt,
    })
    .from(deadLetters)
    .where(and(
      eq(deadLetters.id, input.deadLetterId),
      eq(deadLetters.runId, input.runId),
      eq(deadLetters.nodeId, input.nodeId),
    ))
    .limit(1);
  if (!dlq) return false;

  // The API normally stamps queue acceptance immediately after BullMQ
  // enqueue, but a process crash can land between those two operations. A
  // generation-matched terminal success is stronger evidence than enqueue
  // acceptance, so converge a still-open row here in the same transaction as
  // the impact fact. Preserve `resolved`: an explicit accepted-loss dismissal
  // must not be rewritten by a late in-flight worker.
  await tx
    .update(deadLetters)
    .set({ status: "replayed", replayedAt: input.recoveredAt })
    .where(and(
      eq(deadLetters.id, input.deadLetterId),
      eq(deadLetters.orgId, dlq.orgId),
      eq(deadLetters.runId, input.runId),
      eq(deadLetters.nodeId, input.nodeId),
      eq(deadLetters.status, "open"),
    ));

  const downtimeEndedMs = dlq.createdAt
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, input.recoveredAt.getTime() - dlq.createdAt.getTime()))
    : 0;
  const inserted = await tx
    .insert(recoveryImpactEvents)
    .values({
      deadLetterId: input.deadLetterId,
      orgId: dlq.orgId,
      runId: input.runId,
      nodeId: input.nodeId,
      userId: input.userId,
      recoveredAt: input.recoveredAt,
      downtimeEndedMs,
    })
    .onConflictDoNothing({ target: recoveryImpactEvents.deadLetterId })
    .returning({ deadLetterId: recoveryImpactEvents.deadLetterId });
  if (inserted.length === 0) return false;

  await tx
    .insert(recoveryImpactRollups)
    .values({
      orgId: dlq.orgId,
      totalRecovered: 1,
      downtimeEndedMs,
      firstRecoveredAt: input.recoveredAt,
      updatedAt: input.recoveredAt,
    })
    .onConflictDoUpdate({
      target: recoveryImpactRollups.orgId,
      set: {
        totalRecovered: sql`${recoveryImpactRollups.totalRecovered} + 1`,
        downtimeEndedMs: sql`${recoveryImpactRollups.downtimeEndedMs} + ${downtimeEndedMs}`,
        firstRecoveredAt: sql`least(
          coalesce(${recoveryImpactRollups.firstRecoveredAt}, excluded."first_recovered_at"),
          excluded."first_recovered_at"
        )`,
        updatedAt: sql`greatest(
          ${recoveryImpactRollups.updatedAt},
          excluded."updated_at"
        )`,
      },
    });

  // The incident closes only alongside terminal node success. Keeping this
  // CAS transition and its audit row in the same transaction as the impact
  // fact prevents enqueue acceptance from masquerading as recovery and
  // eliminates a crash gap between the Value Dashboard and ownership views.
  const [linkedChild] = await tx
    .select({ recoveryItemId: recoveryItemChildren.recoveryItemId })
    .from(recoveryItemChildren)
    .where(and(
      eq(recoveryItemChildren.orgId, dlq.orgId),
      eq(recoveryItemChildren.deadLetterId, input.deadLetterId),
    ))
    .limit(1);
  const itemIdentity = linkedChild
    ? or(
        eq(recoveryItems.deadLetterId, input.deadLetterId),
        eq(recoveryItems.id, linkedChild.recoveryItemId),
      )
    : eq(recoveryItems.deadLetterId, input.deadLetterId);
  const [item] = await tx
    .select({
      id: recoveryItems.id,
      status: recoveryItems.status,
      resolutionReason: recoveryItems.resolutionReason,
    })
    .from(recoveryItems)
    .where(and(
      eq(recoveryItems.orgId, dlq.orgId),
      itemIdentity,
    ))
    .limit(1)
    .for("update");
  if (item && item.status !== "resolved") {
    const actor = input.userId ?? "system";
    const firstActionAt = dlq.replayClaimedAt ?? dlq.replayedAt ?? input.recoveredAt;
    const [resolved] = await tx
      .update(recoveryItems)
      .set({
        status: "resolved",
        resolutionReason: "sandbox_replay_succeeded",
        resolvedBy: actor,
        resolvedAt: input.recoveredAt,
        // Raw sql interpolations do not inherit Drizzle's timestamp encoder;
        // pass an ISO string and cast explicitly instead of binding a JS Date.
        firstActionAt: sql`coalesce(
          ${recoveryItems.firstActionAt},
          ${firstActionAt.toISOString()}::timestamptz
        )`,
        updatedAt: input.recoveredAt,
      })
      .where(and(
        eq(recoveryItems.orgId, dlq.orgId),
        eq(recoveryItems.id, item.id),
        eq(recoveryItems.status, item.status),
      ))
      .returning({ id: recoveryItems.id });
    if (resolved) {
      await tx.insert(auditLogs).values({
        id: crypto.randomUUID(),
        orgId: dlq.orgId,
        userId: actor,
        action: "recovery.item.resolved",
        targetType: "recovery-item",
        targetId: item.id,
        metadata: safePersistPayload({
          before: { status: item.status, resolutionReason: item.resolutionReason },
          after: { status: "resolved", resolutionReason: "sandbox_replay_succeeded" },
          resolutionReason: "sandbox_replay_succeeded",
          via: "terminal_recovery",
        }),
        createdAt: input.recoveredAt,
      });
    }
  }

  if (input.playbookId && input.validationRunId) {
    const actor = input.userId ?? "system";
    const applied = await recordRecoveryPlaybookAppliedTx(tx, {
      orgId: dlq.orgId,
      id: input.playbookId,
      validationRunId: input.validationRunId,
      actor,
      recordedAt: input.recoveredAt,
    });
    if (applied.recorded) {
      await tx.insert(auditLogs).values({
        id: crypto.randomUUID(),
        orgId: dlq.orgId,
        userId: actor,
        action: "recovery.playbook.applied",
        targetType: "recovery_playbook",
        targetId: input.playbookId,
        metadata: safePersistPayload({
          deadLetterId: input.deadLetterId,
          validationRunId: input.validationRunId,
          via: "terminal_recovery",
        }),
        createdAt: input.recoveredAt,
      });
    }
  }
  return true;
}

/** Read the tenant's constant-time lifetime recovery projection. */
export async function queryRecoveryLedger(orgId: string): Promise<RecoveryLedgerRepo> {
  const rows = await db
    .select({
      totalRecovered: recoveryImpactRollups.totalRecovered,
      downtimeEndedMs: recoveryImpactRollups.downtimeEndedMs,
      since: recoveryImpactRollups.firstRecoveredAt,
    })
    .from(recoveryImpactRollups)
    .where(eq(recoveryImpactRollups.orgId, orgId))
    .limit(1);

  const row = rows[0];
  const totalRecovered = Number(row?.totalRecovered ?? 0);
  const downtimeEndedMs = Number(row?.downtimeEndedMs ?? 0);
  const since = row?.since ?? null;
  return {
    totalRecovered: Number.isFinite(totalRecovered) ? Math.max(0, Math.floor(totalRecovered)) : 0,
    downtimeEndedMs: Number.isFinite(downtimeEndedMs) ? Math.max(0, Math.round(downtimeEndedMs)) : 0,
    sinceIso: since ? (since instanceof Date ? since : new Date(since)).toISOString() : null,
  };
}

/** Count terminally successful DLQ recoveries attributed to one operator. */
export async function queryOperatorRecoveryCount(
  orgId: string,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recoveryImpactEvents)
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      eq(recoveryImpactEvents.userId, userId),
      gte(recoveryImpactEvents.recoveredAt, since),
    ));
  const count = Number(rows[0]?.count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/** Collect raw recovery-metrics signals for one org over a rolling window. */
export async function queryRecoveryMetricsSignals(
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<RecoveryMetricsSignals> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    runStatusCounts,
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
 * Average + p95 delay from a recovery incident landing to its first meaningful
 * action. Recovery-item transitions use the set-once `first_action_at`; tenants
 * that intentionally disable item creation still contribute through the
 * pre-enqueue DLQ replay claim. Direct and child-linked items are excluded from
 * the fallback branch so one incident is never sampled twice.
 */
export async function queryTimeToFirstAction(
  orgId: string,
  since: Date,
): Promise<TimeToFirstActionRepo> {
  const rows = await db.execute<{
    sample_size: number;
    avg_seconds: number | null;
    p95_seconds: number | null;
  }>(sql`
    WITH samples AS (
      SELECT extract(epoch FROM ("first_action_at" - "created_at"))::float8 AS seconds
      FROM "recovery_items"
      WHERE "org_id" = ${orgId}
        AND "created_at" >= ${since.toISOString()}::timestamptz
        AND "first_action_at" IS NOT NULL

      UNION ALL

      SELECT extract(epoch FROM (
        coalesce(dlq."replay_claimed_at", dlq."replayed_at") - dlq."created_at"
      ))::float8 AS seconds
      FROM "dead_letters" dlq
      WHERE dlq."org_id" = ${orgId}
        AND dlq."created_at" >= ${since.toISOString()}::timestamptz
        AND coalesce(dlq."replay_claimed_at", dlq."replayed_at") IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "recovery_items" item
          WHERE item."org_id" = ${orgId}
            AND item."dead_letter_id" = dlq."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "recovery_item_children" child
          WHERE child."org_id" = ${orgId}
            AND child."dead_letter_id" = dlq."id"
        )
    )
    SELECT
      count(*) FILTER (WHERE seconds >= 0)::int AS sample_size,
      avg(seconds) FILTER (WHERE seconds >= 0)::float8 AS avg_seconds,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY seconds)
        FILTER (WHERE seconds >= 0)::float8 AS p95_seconds
    FROM samples
  `);
  const row = rows[0];
  const avgSeconds = row?.avg_seconds == null ? null : Number(row.avg_seconds);
  const p95Seconds = row?.p95_seconds == null ? null : Number(row.p95_seconds);
  return {
    avgSeconds: avgSeconds != null && Number.isFinite(avgSeconds) ? Math.max(0, avgSeconds) : null,
    p95Seconds: p95Seconds != null && Number.isFinite(p95Seconds) ? Math.max(0, p95Seconds) : null,
    sampleSize: Math.max(0, Number(row?.sample_size ?? 0)),
  };
}

/**
 * Evaluate whether a terminally successful recovery stayed fixed for seven
 * days. The immutable impact event is the fix boundary. A recurrence is either
 * a new item with the same normalized signature or a later child occurrence on
 * the same reopened item. Validation/sandbox runs never count as recurrence.
 */
export async function queryRecoveryRecurrence(
  orgId: string,
  since: Date,
): Promise<RecoveryRecurrenceRepo> {
  const rows = await db.execute<{
    resolved: number;
    recurred: number;
    recurred_signatures: string[] | null;
  }>(sql`
    WITH impact_items AS (
      SELECT
        item."id" AS item_id,
        item."error_signature" AS error_signature,
        impact."recovered_at" AS recovered_at
      FROM "recovery_impact_events" impact
      INNER JOIN "recovery_items" item
        ON item."org_id" = impact."org_id"
       AND item."dead_letter_id" = impact."dead_letter_id"
      WHERE impact."org_id" = ${orgId}
        AND impact."recovered_at" >= ${since.toISOString()}::timestamptz

      UNION ALL

      SELECT
        item."id" AS item_id,
        item."error_signature" AS error_signature,
        impact."recovered_at" AS recovered_at
      FROM "recovery_impact_events" impact
      INNER JOIN "recovery_item_children" child
        ON child."org_id" = impact."org_id"
       AND child."dead_letter_id" = impact."dead_letter_id"
      INNER JOIN "recovery_items" item
        ON item."org_id" = child."org_id"
       AND item."id" = child."recovery_item_id"
      WHERE impact."org_id" = ${orgId}
        AND impact."recovered_at" >= ${since.toISOString()}::timestamptz
    ), recovered_items AS (
      SELECT
        item_id,
        error_signature,
        min(recovered_at) AS recovered_at
      FROM impact_items
      WHERE error_signature IS NOT NULL
      GROUP BY item_id, error_signature
    ), evaluated AS (
      SELECT
        recovered.error_signature,
        (
          EXISTS (
            SELECT 1
            FROM "recovery_items" later_item
            INNER JOIN "dead_letters" later_dlq
              ON later_dlq."org_id" = later_item."org_id"
             AND later_dlq."id" = later_item."dead_letter_id"
            INNER JOIN "runs" later_run
              ON later_run."id" = later_dlq."run_id"
             AND later_run."org_id" = later_item."org_id"
            WHERE later_item."org_id" = ${orgId}
              AND later_item."id" <> recovered.item_id
              AND later_item."error_signature" = recovered.error_signature
              AND later_item."first_occurred_at" > recovered.recovered_at
              AND later_item."first_occurred_at" <= recovered.recovered_at + interval '7 days'
              AND later_run."replay_mode" IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM "recovery_item_children" later_child
            INNER JOIN "dead_letters" later_dlq
              ON later_dlq."org_id" = later_child."org_id"
             AND later_dlq."id" = later_child."dead_letter_id"
            INNER JOIN "runs" later_run
              ON later_run."id" = later_dlq."run_id"
             AND later_run."org_id" = later_child."org_id"
            WHERE later_child."org_id" = ${orgId}
              AND later_child."recovery_item_id" = recovered.item_id
              AND later_child."occurred_at" > recovered.recovered_at
              AND later_child."occurred_at" <= recovered.recovered_at + interval '7 days'
              AND later_run."replay_mode" IS NULL
          )
        ) AS recurred
      FROM recovered_items recovered
    )
    SELECT
      count(*)::int AS resolved,
      count(*) FILTER (WHERE recurred)::int AS recurred,
      coalesce(
        array_agg(DISTINCT error_signature) FILTER (WHERE recurred),
        ARRAY[]::text[]
      ) AS recurred_signatures
    FROM evaluated
  `);
  const row = rows[0];
  return {
    resolved: Math.max(0, Number(row?.resolved ?? 0)),
    recurred: Math.max(0, Number(row?.recurred ?? 0)),
    recurredSignatures: Array.isArray(row?.recurred_signatures)
      ? row.recurred_signatures.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/**
 * Per-day average terminal recovery impact, bucketed by the day success
 * committed. Aggregated entirely
 * in Postgres (one GROUP BY, no row materialization) and bounded to the most
 * recent 14 days with data, returned oldest-first for the MTTR trend sparkline.
 * Multi-tenant scope: `eq(recoveryImpactEvents.orgId, orgId)`.
 */
async function queryMttrTrend(orgId: string, since: Date): Promise<MttrTrendPointRepo[]> {
  const dayBucket = sql`date_trunc('day', ${recoveryImpactEvents.recoveredAt})`;
  const rows = await db
    .select({
      day: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
      seconds: sql<number>`avg(${recoveryImpactEvents.downtimeEndedMs})::float8 / 1000`,
    })
    .from(recoveryImpactEvents)
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
    ))
    .groupBy(dayBucket)
    .orderBy(sql`${dayBucket} desc`)
    .limit(14);

  // Newest-first from SQL → reverse to ascending for the left-to-right
  // sparkline; drop any non-positive average (clock skew).
  return rows
    .map((row) => ({ day: row.day, seconds: Number(row.seconds) }))
    .filter((point) => Number.isFinite(point.seconds) && point.seconds > 0)
    .reverse();
}

/** One per-day cell for the recovery heatmap calendar. */
export type RecoveryHeatmapDay = {
  day: string;
  failures: number;
  recovered: number;
  mttrSeconds: number;
};

const HEATMAP_MAX_DAYS = 90;

/**
 * Per-day failure/recovery counts over the last `days` (clamped 1..90),
 * bucketed by the day the failure landed: `failures` = dead letters created
 * that day, `recovered` = the subset with terminal impact evidence,
 * `mttrSeconds` = avg terminal recovery time. One Postgres GROUP BY,
 * oldest-first. Multi-tenant scope: `eq(deadLetters.orgId, orgId)`. The existing
 * `dead_letters_org_created_idx` covers the window scan.
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
      mttrSeconds: sql<number>`coalesce(avg(${recoveryImpactEvents.downtimeEndedMs}) / 1000, 0)::float8`,
    })
    .from(deadLetters)
    .leftJoin(recoveryImpactEvents, eq(recoveryImpactEvents.deadLetterId, deadLetters.id))
    .where(and(eq(deadLetters.orgId, orgId), gte(deadLetters.createdAt, since)))
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

/**
 * SLA-attainment counts over recovery items resolved in the window. Aggregated
 * in Postgres (two counts, no row materialization): total resolved-in-window
 * and the `resolved_at <= sla_target_at` subset. Multi-tenant scope:
 * `eq(recoveryItems.orgId, orgId)`; the `status='resolved'` predicate rides the
 * `(orgId, status, slaTargetAt)` index and guarantees `resolvedAt` is non-null.
 */
export async function queryRecoverySlaAttainment(
  orgId: string,
  since: Date,
): Promise<SlaAttainmentRepo> {
  const rows = await db
    .select({
      resolvedInWindow: sql<number>`count(*)::int`,
      metSla: sql<number>`count(*) filter (where ${recoveryItems.resolvedAt} <= ${recoveryItems.slaTargetAt})::int`,
    })
    .from(recoveryItems)
    .where(and(
      eq(recoveryItems.orgId, orgId),
      eq(recoveryItems.status, "resolved"),
      gte(recoveryItems.resolvedAt, since),
    ));
  return {
    resolvedInWindow: rows[0]?.resolvedInWindow ?? 0,
    metSla: rows[0]?.metSla ?? 0,
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
  // Terminal recovery duration is materialized atomically with node success.
  // Enqueue acceptance (`dead_letters.status='replayed'`) is not evidence.
  const rows = await db
    .select({
      downtimeEndedMs: recoveryImpactEvents.downtimeEndedMs,
    })
    .from(recoveryImpactEvents)
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
    ))
    .limit(MTTR_SAMPLE_CAP);

  return rows
    .map((row) => Number(row.downtimeEndedMs))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
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
        "id",
        "org_id",
        "run_id",
        "node_id",
        coalesce("replay_claimed_at", "replayed_at") AS "replay_boundary"
      FROM "dead_letters"
      WHERE "org_id" = ${orgId}
        AND coalesce("replay_claimed_at", "replayed_at") >= ${sinceIso}::timestamptz
    ), outcomes AS (
      SELECT
        attempts."id",
        bool_or(impact."dead_letter_id" IS NOT NULL) AS "succeeded",
        bool_or(later."id" IS NOT NULL) AS "reopened"
      FROM attempts
      LEFT JOIN "recovery_impact_events" impact
        ON impact."dead_letter_id" = attempts."id"
      LEFT JOIN "dead_letters" later
        ON later."org_id" = attempts."org_id"
       AND later."run_id" = attempts."run_id"
       AND later."node_id" = attempts."node_id"
       AND later."id" <> attempts."id"
       AND later."created_at" > attempts."replay_boundary"
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

/**
 * Count of distinct failure signatures with terminal recovery impact inside
 * the window. Group-by happens in
 * JS — pgvector / pg-extension functions for signature normalization don't
 * exist; the existing `normalizeErrorSignature` helper is the chokepoint and
 * lives in `@janusly/shared`.
 *
 * Multi-tenant scope: `eq(recoveryImpactEvents.orgId, orgId)`. Bounded at
 * `RESOLVED_CLUSTERS_ROW_CAP`; past the cap, the result is capped and
 * downstream rollup labels the count as "≥ cap" in the UI.
 *
 * NOTE: the cap is on the row count, not the cluster count. An org with
 * many entries per signature gets a true cluster count even when capped,
 * because the distinct-signature math runs over whatever rows came back.
 * Higher-cardinality deployments should replace this bounded scan with
 * pre-aggregated signatures.
 */
export async function queryFailureClustersResolved(
  orgId: string,
  since: Date,
): Promise<ResolvedClustersRepo> {
  const rows = await db
    .select({
      nodeId: deadLetters.nodeId,
      nodeJson: deadLetters.nodeJson,
      errorJson: deadLetters.errorJson,
    })
    .from(recoveryImpactEvents)
    .innerJoin(deadLetters, eq(deadLetters.id, recoveryImpactEvents.deadLetterId))
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
    ))
    .limit(RESOLVED_CLUSTERS_ROW_CAP + 1);

  const capped = rows.length > RESOLVED_CLUSTERS_ROW_CAP;
  const sample = capped ? rows.slice(0, RESOLVED_CLUSTERS_ROW_CAP) : rows;

  const signatures = new Set<string>();
  for (const row of sample) {
    // Derive nodeType + toolName from `nodeJson` so the normalizer's
    // signature is identical to what the failure-clusters surface
    // computes — same string for the same failure, regardless of which
    // query produced it.
    const node = (row.nodeJson as { type?: string; config?: { tool?: string } } | null) ?? null;
    const sig = normalizeErrorSignature(row.errorJson, {
      nodeId: row.nodeId,
      nodeType: node?.type,
      toolName: node?.config?.tool,
    });
    signatures.add(sig.signature);
  }

  return {
    totalClusters: signatures.size,
    totalEntries: sample.length,
    capped,
  };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
