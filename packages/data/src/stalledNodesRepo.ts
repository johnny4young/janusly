/**
 * Read query that surfaces workflow nodes stuck in `running` long past any
 * legitimate execution window — the signature of a worker process that died
 * (kill -9 / OOM / container eviction) mid-node. The runtime's atomic claim
 * (`markNodeRunning`, `queued → running`) means a redelivered BullMQ job for
 * such a node fails its claim and emits `node.skipped`, so the row stays
 * `running` forever and the parent run never reaches a terminal state. This
 * query is the detection half of the stalled-node reaper that closes that
 * recoverability gap.
 *
 * Used by `packages/engine/src/stalled-node-reaper.ts` (the periodic sweep).
 *
 * Invariants:
 * - Multi-tenant: each returned row carries its own `orgId` (from the parent
 *   `runs` row) so the engine-side reaper scopes every follow-up write. This
 *   is a deliberate cross-org sweep (a system maintenance task, like the
 *   retention sweeps) — the per-row `orgId` keeps the downstream writes
 *   tenant-scoped.
 * - Only PRODUCTION runs (`replay_mode IS NULL`) are returned. Sandbox /
 *   validation / replay-lab runs are ephemeral previews the UI abandons on
 *   no-progress; reaping them would add DLQ + recovery-item noise for runs
 *   that carry no durable promise. Matches the `isNull(runs.replayMode)`
 *   exclusion the health / cluster rollups already use.
 * - Only NON-TERMINAL runs are returned — a node left `running` under a run
 *   that already flipped terminal (rare race) is not a stuck run.
 */

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { db, runNodes, runs } from "@janusly/db";

/** Run-level statuses that mean the run is still in flight (not terminal). */
const NON_TERMINAL_RUN_STATUSES = ["created", "running", "waiting"] as const;

/**
 * One node stuck in `running` past the stall threshold, plus the parent-run
 * context the reaper needs to fail it, optionally dead-letter it, and roll the
 * run up to a terminal status.
 */
export type StalledRunningNode = {
  runId: string;
  nodeId: string;
  /** Tenant owner, from the parent `runs` row — every reaper write scopes on this. */
  orgId: string;
  /** Current attempt number carried on the `run_nodes` row (for the DLQ row + event). */
  attempt: number;
  /** When the node was claimed into `running`. Always non-null (the query filters `IS NOT NULL`). */
  startedAt: Date | null;
  /**
   * The `runs.input_json` snapshot. Carries `{ workflow, input }` captured by
   * `startRun`; the reaper reconstructs the exact failed-job payload from
   * `input_json.workflow` for the dead-letter row so `/dlq/replay` works.
   */
  inputJson: unknown;
};

/** Bounded input for {@link findStalledRunningNodes}. */
export type FindStalledRunningNodesInput = {
  /** Nodes whose `started_at` is strictly older than this instant are stalled. */
  olderThan: Date;
  /** Hard cap on rows returned per sweep so one fire never unbounds. */
  limit: number;
  /** Optional exact tenant/run scope for an operator-triggered drill. */
  scope?: { orgId: string; runId: string };
};

/**
 * Find production-run nodes stuck in `running` since before `olderThan`,
 * oldest first, capped at `limit`. Joins `run_nodes` to `runs` for the org +
 * snapshot and to exclude terminal / sandbox runs. Read-only — the engine-side
 * reaper performs the conditional fail + dead-letter + status rollup.
 */
export async function findStalledRunningNodes(
  input: FindStalledRunningNodesInput,
): Promise<StalledRunningNode[]> {
  const limit = Math.max(1, Math.floor(input.limit));
  const rows = await db
    .select({
      runId: runNodes.runId,
      nodeId: runNodes.nodeId,
      attempts: runNodes.attempts,
      startedAt: runNodes.startedAt,
      orgId: runs.orgId,
      inputJson: runs.inputJson,
    })
    .from(runNodes)
    .innerJoin(runs, eq(runs.id, runNodes.runId))
    .where(
      and(
        eq(runNodes.status, "running"),
        sql`${runNodes.startedAt} is not null`,
        lt(runNodes.startedAt, input.olderThan),
        inArray(runs.status, [...NON_TERMINAL_RUN_STATUSES]),
        isNull(runs.replayMode),
        ...(input.scope
          ? [eq(runs.orgId, input.scope.orgId), eq(runs.id, input.scope.runId)]
          : []),
      ),
    )
    .orderBy(runNodes.startedAt)
    .limit(limit);

  return rows.map((row) => ({
    runId: row.runId,
    nodeId: row.nodeId,
    orgId: row.orgId,
    attempt: row.attempts ?? 1,
    startedAt: row.startedAt,
    inputJson: row.inputJson,
  }));
}
