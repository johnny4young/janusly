/** Recovery response, recurrence, and SLA effectiveness queries. */

import { db, deadLetters, recoveryItems, runs } from "@janusly/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type {
  RecoveryRecurrenceRepo,
  SlaAttainmentRepo,
  TimeToFirstActionRepo,
} from "./contracts";

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
      SELECT extract(epoch FROM (
        item."first_action_at" - item."created_at"
      ))::float8 AS seconds
      FROM "recovery_items" item
      INNER JOIN "dead_letters" item_dlq
        ON item_dlq."org_id" = item."org_id"
       AND item_dlq."id" = item."dead_letter_id"
      INNER JOIN "runs" item_run
        ON item_run."org_id" = item."org_id"
       AND item_run."id" = item_dlq."run_id"
      WHERE item."org_id" = ${orgId}
        AND item."created_at" >= ${since.toISOString()}::timestamptz
        AND item."first_action_at" IS NOT NULL
        AND item_run."replay_mode" IS NULL

      UNION ALL

      SELECT extract(epoch FROM (
        coalesce(dlq."replay_claimed_at", dlq."replayed_at") - dlq."created_at"
      ))::float8 AS seconds
      FROM "dead_letters" dlq
      INNER JOIN "runs" fallback_run
        ON fallback_run."org_id" = dlq."org_id"
       AND fallback_run."id" = dlq."run_id"
      WHERE dlq."org_id" = ${orgId}
        AND dlq."created_at" >= ${since.toISOString()}::timestamptz
        AND coalesce(dlq."replay_claimed_at", dlq."replayed_at") IS NOT NULL
        AND fallback_run."replay_mode" IS NULL
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
      INNER JOIN "runs" impact_run
        ON impact_run."id" = impact."run_id"
       AND impact_run."org_id" = impact."org_id"
      INNER JOIN "recovery_items" item
        ON item."org_id" = impact."org_id"
       AND item."dead_letter_id" = impact."dead_letter_id"
      WHERE impact."org_id" = ${orgId}
        AND impact."recovered_at" >= ${since.toISOString()}::timestamptz
        AND impact_run."replay_mode" IS NULL

      UNION ALL

      SELECT
        item."id" AS item_id,
        item."error_signature" AS error_signature,
        impact."recovered_at" AS recovered_at
      FROM "recovery_impact_events" impact
      INNER JOIN "runs" impact_run
        ON impact_run."id" = impact."run_id"
       AND impact_run."org_id" = impact."org_id"
      INNER JOIN "recovery_item_children" child
        ON child."org_id" = impact."org_id"
       AND child."dead_letter_id" = impact."dead_letter_id"
      INNER JOIN "recovery_items" item
        ON item."org_id" = child."org_id"
       AND item."id" = child."recovery_item_id"
      WHERE impact."org_id" = ${orgId}
        AND impact."recovered_at" >= ${since.toISOString()}::timestamptz
        AND impact_run."replay_mode" IS NULL
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
    .innerJoin(
      deadLetters,
      and(
        eq(deadLetters.orgId, recoveryItems.orgId),
        eq(deadLetters.id, recoveryItems.deadLetterId),
      ),
    )
    .innerJoin(
      runs,
      and(
        eq(runs.orgId, recoveryItems.orgId),
        eq(runs.id, deadLetters.runId),
      ),
    )
    .where(and(
      eq(recoveryItems.orgId, orgId),
      eq(recoveryItems.status, "resolved"),
      gte(recoveryItems.resolvedAt, since),
      isNull(runs.replayMode),
    ));
  return {
    resolvedInWindow: rows[0]?.resolvedInWindow ?? 0,
    metSla: rows[0]?.metSla ?? 0,
  };
}
