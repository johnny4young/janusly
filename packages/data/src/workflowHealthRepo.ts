/**
 * Repository for workflow health signals — the run-time inputs the
 * `computeWorkflowHealth` aggregator (in `@janusly/engine`) consumes.
 *
 * Single function `queryHealthSignals(orgId, workflowId, windowDays,
 * versionFilter?)` runs the SQL aggregations across `runs`,
 * `run_events`, `dead_letters`, `usage_events`, and `workflow_versions`
 * for one workflow over a rolling window. Returns the typed
 * `HealthSignals` shape the engine expects. The optional 4th argument
 * lets the recovery delta route split the same window by version side
 * (before / after a recovery patch) so before/after deltas reuse the
 * same query plan.
 *
 * Used by `apps/api/src/index.ts:GET /workflows/health` (no version
 * filter) and `GET /workflows/health/delta` (called twice per request,
 * once per side). The engine layer
 * computes the score from these signals + the static readiness check;
 * this module only collects.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries `eq(workflowVersions.orgId,
 *   orgId)` AND `eq(workflowVersions.workflowId, workflowId)`. Joining
 *   through `workflow_versions` enforces both scopes in a single
 *   predicate set.
 * - Window cap: matches `getUsageSummary`'s 30-day default. Don't unbound
 *   the scan — long-running orgs would OOM the API on every dashboard
 *   poll. Pre-aggregated tables come later if needed.
 * - p95 below 5 runs is unstable, so we return `null` and let the engine
 *   fall back to its neutral default rather than emit a noisy small-N
 *   percentile.
 *
 * Note on the cross-module shape: `HealthSignals` is duplicated here and
 * in `@janusly/engine/src/workflow-health.ts` so `data` never imports
 * from `engine`. The API wires repo → engine through structural typing.
 */

import { db } from "@janusly/db";
import { runs, runEvents, deadLetters, usageEvents, workflowVersions } from "@janusly/db";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

/**
 * Optional version-cutoff filter for `queryHealthSignals`. Used by the
 * recovery before/after delta route to split the same time window by
 * version: rows with `workflow_versions.version < cutoffVersion` form
 * the "before" side; rows with `version >= cutoffVersion` form the
 * "after" side. Discriminated union so the SQL switch is exhaustive at
 * compile time.
 */
export type VersionFilter =
  | { side: "before"; cutoffVersion: number }
  | { side: "after"; cutoffVersion: number };

/**
 * Run-time signals collected for one workflow over a rolling window.
 *
 * Defined here (not in `@janusly/engine`) because `packages/data` is a
 * lower layer than `engine` — `engine` imports from `data`, never the
 * other way around. The engine's `computeWorkflowHealth` accepts this
 * exact shape via structural typing; both modules duplicate the field
 * list to keep the dependency direction clean. Adding a field means
 * editing both type definitions; the repo's tests + the engine's
 * `computeWorkflowHealth.test.ts` together pin both shapes.
 */
export type HealthSignals = {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  dlqOpenCount: number;
  p95LatencyMs: number | null;
  totalCostUsd: number;
  totalTokens: number;
  versionCount: number;
};

export const DEFAULT_HEALTH_WINDOW_DAYS = 30;

/** Run all signal-collection queries for one workflow + return the typed shape. */
export async function queryHealthSignals(
  orgId: string,
  workflowId: string,
  windowDays = DEFAULT_HEALTH_WINDOW_DAYS,
  versionFilter?: VersionFilter,
): Promise<HealthSignals> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Optional version cutoff: split the same window by version side. The
  // before-side counts runs whose version < cutoff; the after-side counts
  // runs whose version >= cutoff. Used by the recovery delta route to
  // compare "before Apply" vs "after Apply" without splitting the window.
  const versionPredicate = versionFilter
    ? versionFilter.side === "before"
      ? lt(workflowVersions.version, versionFilter.cutoffVersion)
      : gte(workflowVersions.version, versionFilter.cutoffVersion)
    : undefined;

  // 1. Run aggregates: total / success / failure counts + run-id list for
  //    follow-up joins. The list lets us scope subsequent queries by the
  //    same set of run rows the success counts were computed against,
  //    without re-running the (org, workflow) join.
  const runRows = await db
    .select({
      id: runs.id,
      status: runs.status,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(and(
      eq(workflowVersions.orgId, orgId),
      eq(workflowVersions.workflowId, workflowId),
      gte(runs.createdAt, since),
      // Exclude sandbox/validation runs — they execute in dryRun mode
      // (skipping write-side actions) and would skew reliability,
      // latency, and cost signals against production runs.
      isNull(runs.replayMode),
      ...(versionPredicate ? [versionPredicate] : []),
    ));

  const totalRuns = runRows.length;
  const successCount = runRows.filter((row) => row.status === "succeeded").length;
  const failureCount = runRows.filter((row) => row.status === "failed").length;
  const runIds = runRows.map((row) => row.id);

  // 2. Retry events + DLQ + usage signals. Each is gated on the runIds
  //    above so we never read rows that belong to a different workflow.
  const [retryCount, dlqOpenCount, usageAggregate, p95LatencyMs] = await Promise.all([
    countRetryEvents(runIds),
    countOpenDeadLetters(orgId, runIds),
    sumUsage(orgId, runIds),
    computeP95Latency(runIds, windowDays),
  ]);

  // 3. Distinct version count for the workflow — independent of the run
  //    window. Rollback availability checks rely on `versionCount >= 2`.
  const versionRows = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(and(
      eq(workflowVersions.orgId, orgId),
      eq(workflowVersions.workflowId, workflowId),
    ));

  return {
    totalRuns,
    successCount,
    failureCount,
    retryCount,
    dlqOpenCount,
    p95LatencyMs,
    totalCostUsd: usageAggregate.totalCostUsd,
    totalTokens: usageAggregate.totalTokens,
    versionCount: versionRows.length,
  };
}

async function countRetryEvents(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  // `inArray` for the runIds gate — `sql\`= ANY (${runIds})\`` was binding
  // the JS array as a single text param under drizzle 1.0 RC, producing
  // `= ANY ($3)` where $3 is a string and Postgres rejected the query.
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runEvents)
    .where(and(
      eq(runEvents.type, "node.retry"),
      inArray(runEvents.runId, runIds),
    ));
  return rows[0]?.count ?? 0;
}

async function countOpenDeadLetters(orgId: string, runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deadLetters)
    .where(and(
      eq(deadLetters.orgId, orgId),
      eq(deadLetters.status, "open"),
      inArray(deadLetters.runId, runIds),
    ));
  return rows[0]?.count ?? 0;
}

async function sumUsage(orgId: string, runIds: string[]): Promise<{ totalCostUsd: number; totalTokens: number }> {
  if (runIds.length === 0) return { totalCostUsd: 0, totalTokens: 0 };
  const rows = await db
    .select({
      quantity: usageEvents.quantity,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.orgId, orgId),
      inArray(usageEvents.runId, runIds),
    ));

  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const row of rows) {
    totalTokens += row.quantity ?? 0;
    const metadata = row.metadata as { costUsd?: number } | null;
    const cost = metadata?.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      totalCostUsd += cost;
    }
  }
  return { totalCostUsd, totalTokens };
}

/**
 * Compute p95 of per-run latency (MAX(createdAt) - MIN(createdAt) per
 * run, milliseconds) across the supplied `runIds`, using Postgres
 * `PERCENTILE_CONT` so the whole computation lives in one round-trip
 * instead of pulling every `run_events` row into the API process.
 *
 * Returns `null` for sample sizes below 5 (matches the engine's
 * `MIN_RUNS_FOR_DELTA` neutral-default floor; preserves the legacy JS
 * implementation's short-circuit). The inner row scan is bounded by
 * `windowDays * 1440 * 2` — a defensive "two events per minute is the
 * worst-case rate; past that the workflow is broken" ceiling.
 *
 * @internal Exported for unit tests; not part of the public repo surface.
 *           Production callers go through `queryHealthSignals`.
 */
export async function computeP95Latency(
  runIds: string[],
  windowDays: number,
): Promise<number | null> {
  if (runIds.length < 5) return null;
  // Defensive ceiling on the row fan-in. Worst-case shape is two events
  // per minute per run; past `windowDays * 1440 * 2` rows the workflow
  // is misbehaving and the rollup is meaningless anyway. The LIMIT
  // applies at the inner scan so Postgres reads at most this many rows
  // before grouping.
  const rowCap = windowDays * 1440 * 2;

  // Per-run latency uses MAX(createdAt) - MIN(createdAt) — the same
  // metric the legacy JS path measured: span from first to last event
  // recorded for the run. PERCENTILE_CONT interpolates between adjacent
  // samples per the SQL standard (the prior JS implementation did
  // nearest-rank); for typical latency distributions the two values
  // agree within a few percent. If strict nearest-rank parity is ever
  // required, swap to PERCENTILE_DISC — single-word change.
  // postgres-js returns a RowList (array-like) directly from execute;
  // access [0] not .rows[0].
  // The inner subquery aliases `run_events.run_id` / `run_events.created_at`
  // as the local `capped.run_id` / `capped.created_at`; outer scopes
  // reference the unqualified column names since the table reference
  // is only in scope inside the LIMIT'd subquery.
  const rows = await db.execute<{ p95_ms: string | number | null }>(sql`
    SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms
    FROM (
      SELECT EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) * 1000 AS duration_ms
      FROM (
        SELECT ${runEvents.runId} AS run_id, ${runEvents.createdAt} AS created_at
        FROM ${runEvents}
        WHERE ${inArray(runEvents.runId, runIds)}
        LIMIT ${rowCap}
      ) capped
      GROUP BY run_id
      HAVING MAX(created_at) > MIN(created_at)
    ) per_run
    HAVING COUNT(*) >= 5
  `);

  const row = rows[0];
  if (!row || row.p95_ms === null || row.p95_ms === undefined) return null;
  return typeof row.p95_ms === "string" ? Number(row.p95_ms) : row.p95_ms;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
