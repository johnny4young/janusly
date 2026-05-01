/**
 * Drizzle-backed write helpers for run / node lifecycle + event append.
 * Function-style API so `core/runtime.ts` can call them directly without
 * threading through `ExecutionStore`; the adapter
 * (`adapters/postgres-execution-store.ts`) wraps them for callers that
 * want the interface boundary.
 *
 * Used by `worker.ts`, `core/runtime.ts`, `start-run.ts`, `resume-run.ts`,
 * and the API's DLQ replay path.
 *
 * Invariants:
 * - `tryClaimNodeForQueue` is the atomic claim — `UPDATE … WHERE
 *   status='pending'`. Don't reintroduce a non-atomic `markNodeQueued` for
 *   newly-ready nodes.
 * - All writers carry no `orgId` parameter — callers carry the scope and
 *   use `getRunOrgId` when they need it (the route layer is the gate).
 */

import { db } from "@janusly/db";
import { runNodes, runEvents, runs } from "@janusly/db";
import { eq, and, inArray } from "drizzle-orm";

/** Return the current top-level run status, or `null` when the row is absent. */
export async function getRunStatus(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0]?.status ?? null;
}

/**
 * Resolve the multi-tenant `orgId` for a run. Used by `executeNode` to thread
 * the scope into `NodeContext` so executors (notably the LLM-calling `ai`
 * step and `agent` planner) can attribute usage telemetry. Returns
 * `null` when the run row doesn't exist; callers treat that as fatal.
 */
export async function getRunOrgId(runId: string): Promise<string | null> {
  const rows = await db
    .select({ orgId: runs.orgId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.orgId ?? null;
}

/** Cancel a run + every still-open node, append a `run.cancelled` event. */
export async function cancelRun(runId: string, reason?: any) {
  await db.update(runs)
    .set({ status: "cancelled" })
    .where(eq(runs.id, runId));

  await db.update(runNodes)
    .set({ status: "cancelled", stateJson: { cancelled: reason ?? {} }, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), inArray(runNodes.status, ["pending", "queued", "waiting"])));

  await appendEvent(runId, null, "run.cancelled", reason ?? {});
}

/** Transition a node to `running` and stamp `startedAt`. */
export async function markNodeRunning(runId: string, nodeId: string, attempt = 1) {
  await db.update(runNodes)
    .set({ status: "running", attempts: attempt, startedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Unconditional transition to `queued` (caller has already claimed). */
export async function markNodeQueued(runId: string, nodeId: string, attempt = 1) {
  await db.update(runNodes)
    .set({ status: "queued", attempts: attempt })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/**
 * Atomic claim — flip `pending → queued` only when the row is still
 * `pending`. Returns `true` on success, `false` when another worker
 * already claimed. This invariant must not be replaced with a non-atomic
 * read-then-write.
 */
export async function tryClaimNodeForQueue(runId: string, nodeId: string, attempt = 1): Promise<boolean> {
  const claimed = await db.update(runNodes)
    .set({ status: "queued", attempts: attempt })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "pending"),
    ))
    .returning({ id: runNodes.id });
  return claimed.length > 0;
}

/** Transition a node to `waiting` (webhook / approval pause). Metadata stored under `state_json.waiting`. */
export async function markNodeWaiting(runId: string, nodeId: string, metadata?: any) {
  await db.update(runNodes)
    .set({ status: "waiting", stateJson: { waiting: metadata ?? {} } })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node skipped (e.g. edge condition false). Terminal — `finishedAt` set. */
export async function markNodeSkipped(runId: string, nodeId: string, reason?: any) {
  await db.update(runNodes)
    .set({ status: "skipped", stateJson: { skipped: reason ?? {} }, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node succeeded; `output` lands under `state_json.output` (the web Inspector reads from there). */
export async function markNodeSucceeded(runId: string, nodeId: string, output?: any) {
  await db.update(runNodes)
    .set({ status: "succeeded", stateJson: { output: output ?? {} }, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node failed with the serialized error in `error_json`. Terminal. */
export async function markNodeFailed(runId: string, nodeId: string, error: any) {
  await db.update(runNodes)
    .set({ status: "failed", errorJson: error, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Roll up node statuses to the run-level status. Cancelled stays cancelled; any failed → failed; all-terminal → succeeded; otherwise running. */
export async function updateRunStatusFromNodes(runId: string) {
  const status = await getRunStatus(runId);
  if (status === "cancelled") return "cancelled";

  const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  if (nodes.some(node => node.status === "failed")) {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
    return "failed";
  }

  const openStatuses = new Set(["pending", "queued", "running", "waiting"]);
  if (nodes.length > 0 && nodes.every(node => !openStatuses.has(node.status))) {
    await db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, runId));
    return "succeeded";
  }

  return "running";
}

/** Insert one row into `run_events`. The web's run timeline reads these. */
export async function appendEvent(runId: string, nodeId: string | null, type: string, payload: any) {
  await db.insert(runEvents).values({
    id: crypto.randomUUID(),
    runId,
    nodeId,
    type,
    payload,
  });
}

/** Build the per-run context dict (`{ [nodeId]: { status, output, ... } }`) every executor receives. */
export async function getRunContext(runId: string) {
  const rows = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  return rows.reduce<Record<string, any>>((acc, row) => {
    acc[row.nodeId] = {
      status: row.status,
      attempts: row.attempts ?? 0,
      state: row.stateJson ?? {},
      output: (row.stateJson as any)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}
