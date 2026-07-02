/**
 * Repository for cron-observability history — the raw schedule-fire
 * timestamps the heatmap aggregator (`bucketScheduleFires` in
 * `@janusly/engine`) folds into a day-of-week × hour-of-day grid.
 *
 * `queryScheduleFires(orgId, workflowId, windowDays, rowCap)` collects every
 * scheduled run for one workflow over a rolling window: `runs` joined through
 * `workflow_versions` (the multi-tenant + workflow scope), filtered to runs
 * the scheduler created (`input_json -> 'input' ->> 'triggeredBy' =
 * 'schedule'`). Each row carries the fire instant (`runs.created_at`) and the
 * run's terminal status so the engine can compute the per-cell success/fail
 * ratio. `findScheduleEntriesForWorkflow` exposes the workflow's schedule
 * entries (cron expression + last-fire marker) so the route can drive the
 * next-N-fires preview and surface the persisted `last_run_at` for entries
 * whose run rows aged out of the window.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts:GET
 * /workflows/:id/schedule-history`.
 *
 * Invariants:
 * - Multi-tenant scope: the fire query joins through `workflow_versions` and
 *   carries `eq(workflowVersions.orgId, orgId)` AND
 *   `eq(workflowVersions.workflowId, workflowId)` — both scopes in one
 *   predicate set, the same shape `queryHealthSignals` uses. The
 *   schedule-entry read filters `eq(scheduleEntries.orgId, orgId)` directly.
 * - Bounded scan: `windowDays` is clamped to `[1, 90]` and the row scan is
 *   `LIMIT`ed to `rowCap` (≤ 1000) so a busy minutely cron can't fan an
 *   unbounded result into the API process. Newest fires win the cap (ORDER
 *   BY created_at DESC) so the most-recent activity is always represented.
 * - Validation runs (`replayMode = "validation"`) never carry the
 *   `triggeredBy: "schedule"` marker (the scheduler is the only writer of
 *   that input shape), so they're structurally excluded; the explicit
 *   `IS NULL` on `replay_mode` is belt-and-suspenders against a future
 *   trigger path reusing the marker.
 */

import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, runs, scheduleEntries, workflowVersions } from "@janusly/db";

/** Hard ceiling on the lookback window — mirrors the engine's `MAX_HISTORY_DAYS`. */
export const MAX_SCHEDULE_HISTORY_DAYS = 90;

/** Hard ceiling on the row scan — mirrors the engine's `MAX_FIRE_ROWS`. */
export const MAX_SCHEDULE_FIRE_ROWS = 1000;

/** One observed scheduled fire: the instant + the run's terminal status. */
export type ScheduleFireRow = {
  firedAt: Date;
  status: string;
};

/**
 * Collect scheduled-run fires for one workflow over the window. Org- and
 * workflow-scoped via the `workflow_versions` join. Newest-first, capped at
 * `rowCap`. Empty array when the workflow has never been scheduled (or has no
 * runs in the window).
 */
export async function queryScheduleFires(
  orgId: string,
  workflowId: string,
  windowDays: number,
  rowCap: number = MAX_SCHEDULE_FIRE_ROWS,
): Promise<ScheduleFireRow[]> {
  const clampedDays = Math.min(MAX_SCHEDULE_HISTORY_DAYS, Math.max(1, Math.trunc(windowDays)));
  const clampedCap = Math.min(MAX_SCHEDULE_FIRE_ROWS, Math.max(1, Math.trunc(rowCap)));
  const since = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      firedAt: runs.createdAt,
      status: runs.status,
    })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(
      and(
        eq(workflowVersions.orgId, orgId),
        eq(workflowVersions.workflowId, workflowId),
        // Only runs the scheduler created — the cron trigger stamps
        // `input.triggeredBy = "schedule"` in `start-run`'s persisted
        // `input_json`. Manual `POST /start` runs and subworkflow children
        // never carry this marker, so they're excluded from the heatmap.
        sql`${runs.inputJson} -> 'input' ->> 'triggeredBy' = 'schedule'`,
        // Belt-and-suspenders: scheduled runs are always production runs, but
        // exclude any validation/sandbox run defensively.
        isNull(runs.replayMode),
        gte(runs.createdAt, since),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(clampedCap);

  const out: ScheduleFireRow[] = [];
  for (const row of rows) {
    if (row.firedAt instanceof Date && typeof row.status === "string") {
      out.push({ firedAt: row.firedAt, status: row.status });
    }
  }
  return out;
}

/**
 * Batched variant of {@link queryScheduleFires} for the alerts scanner: ONE
 * SQL round-trip for up to `SCHEDULE_ANOMALY_MAX_WORKFLOWS` workflows instead
 * of a per-workflow query fan-out. Same filters and multi-tenant scope; the
 * per-workflow newest-first `rowCap` is enforced with a
 * `ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY created_at DESC)`
 * window so the cap semantics match the single-workflow read exactly.
 * Workflows with no fires in the window are simply absent from the map.
 */
export async function queryScheduleFiresByWorkflow(
  orgId: string,
  workflowIds: string[],
  windowDays: number,
  rowCapPerWorkflow: number = MAX_SCHEDULE_FIRE_ROWS,
): Promise<Map<string, ScheduleFireRow[]>> {
  const out = new Map<string, ScheduleFireRow[]>();
  if (workflowIds.length === 0) return out;

  const clampedDays = Math.min(MAX_SCHEDULE_HISTORY_DAYS, Math.max(1, Math.trunc(windowDays)));
  const clampedCap = Math.min(MAX_SCHEDULE_FIRE_ROWS, Math.max(1, Math.trunc(rowCapPerWorkflow)));
  const since = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000);

  const ranked = db
    .select({
      workflowId: workflowVersions.workflowId,
      firedAt: runs.createdAt,
      status: runs.status,
      rn: sql<number>`row_number() over (partition by ${workflowVersions.workflowId} order by ${runs.createdAt} desc)`.as("rn"),
    })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(
      and(
        eq(workflowVersions.orgId, orgId),
        inArray(workflowVersions.workflowId, workflowIds),
        sql`${runs.inputJson} -> 'input' ->> 'triggeredBy' = 'schedule'`,
        isNull(runs.replayMode),
        gte(runs.createdAt, since),
      ),
    )
    .as("scheduled_fires");

  const rows = await db
    .select({ workflowId: ranked.workflowId, firedAt: ranked.firedAt, status: ranked.status })
    .from(ranked)
    .where(lte(ranked.rn, clampedCap))
    .orderBy(ranked.workflowId, desc(ranked.firedAt));

  for (const row of rows) {
    if (!(row.firedAt instanceof Date) || typeof row.status !== "string") continue;
    const list = out.get(row.workflowId) ?? [];
    list.push({ firedAt: row.firedAt, status: row.status });
    out.set(row.workflowId, list);
  }
  return out;
}

/** A workflow's schedule entry surfaced for the observability panel. */
export type ScheduleEntrySummary = {
  nodeId: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastRunId: string | null;
  workflowVersionId: string;
};

/**
 * List the schedule entries attached to a workflow (any version), org-scoped.
 * Drives the next-N-fires preview (one preview per enabled entry's cron
 * expression) and surfaces `last_run_at` so an entry whose run rows aged out
 * of the heatmap window still shows a "last fired" marker.
 */
export async function findScheduleEntriesForWorkflow(
  orgId: string,
  workflowId: string,
): Promise<ScheduleEntrySummary[]> {
  const rows = await db
    .select({
      nodeId: scheduleEntries.nodeId,
      cronExpression: scheduleEntries.cronExpression,
      enabled: scheduleEntries.enabled,
      lastRunAt: scheduleEntries.lastRunAt,
      lastRunId: scheduleEntries.lastRunId,
      workflowVersionId: scheduleEntries.workflowVersionId,
    })
    .from(scheduleEntries)
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.workflowId, workflowId)));

  return rows.map((row) => ({
    nodeId: row.nodeId,
    cronExpression: row.cronExpression,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt ?? null,
    lastRunId: row.lastRunId ?? null,
    workflowVersionId: row.workflowVersionId,
  }));
}

// Multi-tenant invariant: tenant-scoped reads keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
