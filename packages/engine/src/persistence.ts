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

import { db, runNodes, runEvents, runs, workflowVersions } from "@janusly/db";
import { eq, and, inArray } from "drizzle-orm";
import { WorkflowSchema } from "@janusly/shared";
import { isOpenNodeStatus, nodeCancellableStatusValues } from "@janusly/shared/src/status";
import { projectOutputs } from "./outputs-projector";
import { publishRunEvent } from "./run-event-stream";
import { safePersistPayload } from "./safe-persist";

// Per-surface size caps for jsonb writes. The chokepoint's default cap
// (256 KB) is conservative for narrow surfaces (events, errors, audit) but
// too tight for `state_json.output` which legitimately carries http body
// outputs up to the http chokepoint's 1 MB cap. Each surface picks the cap
// that matches its real-world payload distribution; over-cap writes get a
// `__truncated` sentinel via `safePersistPayload`.
const STATE_JSON_MAX_BYTES = 1_000_000;
const ERROR_JSON_MAX_BYTES = 64_000;

/** Return the current top-level run status, or `null` when the row is absent. */
export async function getRunStatus(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0]?.status ?? null;
}

/**
 * Return the current status of a single node in a run, or `null` when the
 * row is absent. Used by delayed wake-up handlers to short-circuit when a
 * paused node has already been advanced (manual resume, cancellation, etc.).
 */
export async function getRunNodeStatus(runId: string, nodeId: string): Promise<string | null> {
  const rows = await db
    .select({ status: runNodes.status })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .limit(1);
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

/**
 * Resolve the optional `replayMode` tag on a run. Sister to `getRunOrgId`,
 * loaded once per node execution by `executeNode` so `NodeContext.dryRun`
 * can be set when this is `"validation"`. Returns `null` for production
 * runs and for missing rows; callers treat both as "not a sandbox run."
 */
export async function getRunReplayMode(runId: string): Promise<string | null> {
  const rows = await db
    .select({ replayMode: runs.replayMode })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.replayMode ?? null;
}

/** Stable per-run metadata loaded once at runtime entry: org scope, the
 *  active workflow-version pointer, the workflow id (resolved through the
 *  versions table), and the user who started the run. */
export type RunMetadata = {
  orgId: string;
  workflowVersionId: string;
  workflowId: string | null;
  createdBy: string | null;
};

/**
 * Load the small bag of stable metadata the runtime needs whenever it has
 * to write org-scoped rows (`routing_stats`, `workflow_improvements`) or
 * decide whether the improvement-evaluation path is even applicable.
 *
 * Sister to `getRunOrgId` — same single-row, indexed-by-PK lookup, just
 * widened to also include `workflowVersionId` (off the run row), the
 * resolved `workflowId` (joined through `workflow_versions`), and the
 * `createdBy` user.
 *
 * Returns `null` when the run row is missing (rare race: the run was
 * deleted between scheduling and worker pickup). Callers must treat that
 * as a soft failure — skip the metadata-dependent branch but let the
 * executor still make progress; engine atomicity is unaffected.
 *
 * The `leftJoin` on `workflow_versions` keeps the helper resilient when a
 * stale `workflowVersionId` points at a deleted version row: `workflowId`
 * comes back `null` and the runtime no-ops the improvement path while the
 * run itself completes.
 */
export async function getRunMetadata(runId: string): Promise<RunMetadata | null> {
  const rows = await db
    .select({
      orgId: runs.orgId,
      workflowVersionId: runs.workflowVersionId,
      workflowId: workflowVersions.workflowId,
      createdBy: runs.createdBy,
    })
    .from(runs)
    .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    orgId: row.orgId,
    workflowVersionId: row.workflowVersionId,
    workflowId: row.workflowId ?? null,
    createdBy: row.createdBy ?? null,
  };
}

/** Cancel a run + every still-open node, append a `run.cancelled` event. */
export async function cancelRun(runId: string, reason?: any) {
  await db.update(runs)
    .set({ status: "cancelled" })
    .where(eq(runs.id, runId));

  await db.update(runNodes)
    .set({ status: "cancelled", stateJson: safePersistPayload({ cancelled: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    // `running` is intentionally excluded — running nodes finish naturally;
    // the runtime's post-success guard then skips downstream scheduling.
    .where(and(eq(runNodes.runId, runId), inArray(runNodes.status, [...nodeCancellableStatusValues])));

  await appendEvent(runId, null, "run.cancelled", reason ?? {});
  // Subworkflow children: a cancelled child still notifies the parent so the
  // parent's subworkflow node fails (the parent decides whether to roll up).
  await notifyOnTerminal(runId, "cancelled");
  publishRunEvent(runId, { kind: "run.status", status: "cancelled" });
}

/**
 * Conditional `queued → running` transition. Returns `true` when the row
 * was successfully claimed, `false` when the row had already advanced past
 * `queued` (e.g. cancelled by a sibling cancellation, swept past by another
 * worker, etc.).
 *
 * The conditional WHERE makes this an atomic claim — same shape as
 * `tryClaimNodeForQueue`'s `pending → queued` invariant. The runtime's
 * `executeQueuedNode` checks the boolean and emits a `node.skipped` event
 * when the claim fails, so a cancellation that lands while a queued job is
 * being pulled never re-flips the cancelled row back to running.
 */
export async function markNodeRunning(runId: string, nodeId: string, attempt = 1): Promise<boolean> {
  const claimed = await db.update(runNodes)
    .set({ status: "running", attempts: attempt, startedAt: new Date() })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "queued"),
    ))
    .returning({ id: runNodes.id });
  return claimed.length > 0;
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
 *
 * Invariant (AGENTS.md "Concurrency"): this conditional UPDATE is the
 * only multi-worker double-claim guard; racing workers get true/false
 * from the same atomic write. No read-then-write refactors.
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
    .set({ status: "waiting", stateJson: safePersistPayload({ waiting: metadata ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }) })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node skipped (e.g. edge condition false). Terminal — `finishedAt` set. */
export async function markNodeSkipped(runId: string, nodeId: string, reason?: any) {
  await db.update(runNodes)
    .set({ status: "skipped", stateJson: safePersistPayload({ skipped: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node succeeded; `output` lands under `state_json.output` (the web Inspector reads from there). */
export async function markNodeSucceeded(runId: string, nodeId: string, output?: any) {
  await db.update(runNodes)
    .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Conditionally complete a paused node. Returns false when it was already resumed/cancelled/failed. */
export async function markWaitingNodeSucceeded(runId: string, nodeId: string, output?: any): Promise<boolean> {
  const completed = await db.update(runNodes)
    .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId), eq(runNodes.status, "waiting")))
    .returning({ id: runNodes.id });
  return completed.length > 0;
}

/** Mark a node failed with the serialized error in `error_json`. Terminal. */
export async function markNodeFailed(runId: string, nodeId: string, error: any) {
  await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/**
 * Subworkflow terminal-notifier hook. `subworkflow.ts` registers its
 * `notifyParentOnTerminal` here at module load via `setSubworkflowNotifier`
 * — `persistence.ts` then calls it after a terminal status flip, without
 * importing `subworkflow.ts` directly (which would create an import cycle).
 */
type SubworkflowNotifier = (runId: string, status: "succeeded" | "failed" | "cancelled") => Promise<void>;
let subworkflowNotifier: SubworkflowNotifier | null = null;

/** Wire the subworkflow notifier. Called from `subworkflow.ts` once at module load. */
export function setSubworkflowNotifier(notifier: SubworkflowNotifier | null): void {
  subworkflowNotifier = notifier;
}

async function notifyOnTerminal(runId: string, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
  if (!subworkflowNotifier) return;
  try {
    await subworkflowNotifier(runId, status);
  } catch {
    // Notifier failures are isolated by `subworkflow.ts` itself; this is a
    // defense-in-depth catch so a runaway throw can't take down the
    // status-flip caller.
  }
}

/** Roll up node statuses to the run-level status. Cancelled stays cancelled; any failed → failed; all-terminal → succeeded; otherwise running. */
export async function updateRunStatusFromNodes(runId: string) {
  const status = await getRunStatus(runId);
  if (status === "cancelled" || status === "succeeded" || status === "failed" || status === "timed_out") {
    return status;
  }

  const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  if (nodes.some(node => node.status === "failed")) {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
    await notifyOnTerminal(runId, "failed");
    publishRunEvent(runId, { kind: "run.status", status: "failed" });
    return "failed";
  }

  if (nodes.length > 0 && nodes.every(node => !isOpenNodeStatus(node.status))) {
    // Project the workflow's declared `outputs` (if any) into runs.outputJson
    // BEFORE flipping status, so a single UPDATE carries both writes.
    const outputJson = await computeRunOutputs(runId);
    await db.update(runs)
      .set({ status: "succeeded", outputJson })
      .where(eq(runs.id, runId));
    await notifyOnTerminal(runId, "succeeded");
    publishRunEvent(runId, { kind: "run.status", status: "succeeded" });
    return "succeeded";
  }

  return "running";
}

/**
 * Project the workflow's declared `outputs` against the run's terminal
 * context. Returns `null` for runs without a declared `workflow.outputs`
 * (the column stays NULL — UI shows nothing).
 *
 * The workflow JSON is read from `runs.inputJson.workflow` — the snapshot
 * captured by `startRun` at run-start time. This is intentional: ad-hoc
 * runs don't have a `workflow_versions` row, and saved runs should still
 * project against the workflow as it was when the run started (immune to
 * subsequent edits to the saved workflow).
 *
 * Multi-tenant: scoped by `runId` (callers carry the org gate). No new
 * cross-tenant query introduced.
 */
async function computeRunOutputs(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select({ inputJson: runs.inputJson }).from(runs).where(eq(runs.id, runId)).limit(1);
  const inputJson = rows[0]?.inputJson as { workflow?: unknown; input?: unknown } | null;
  if (!inputJson || typeof inputJson !== "object") return null;

  const workflowParsed = WorkflowSchema.safeParse(inputJson.workflow);
  if (!workflowParsed.success || !workflowParsed.data.outputs) return null;

  const context = await getRunContext(runId);
  const inputs = inputJson.input ?? {};
  return projectOutputs(workflowParsed.data.outputs, context, inputs);
}

/** Insert one row into `run_events`. The web's run timeline reads these. */
export async function appendEvent(runId: string, nodeId: string | null, type: string, payload: any) {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  // Redact ONCE, then both persist and publish the same object — a streamed
  // event can never expose a value the persisted row wouldn't.
  const redacted = safePersistPayload(payload);
  await db.insert(runEvents).values({
    id,
    runId,
    nodeId,
    type,
    payload: redacted,
    createdAt,
  });
  publishRunEvent(runId, {
    kind: "event",
    id,
    nodeId,
    type,
    payload: redacted,
    createdAt: createdAt.toISOString(),
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
      output: (row.stateJson as { output?: unknown } | null)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}
