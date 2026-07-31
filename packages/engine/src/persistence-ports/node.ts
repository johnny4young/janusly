/** Node execution claims, waiting checkpoints, and terminal transitions. */

import { db, runEvents, runNodes, runs } from "@janusly/db";
import { recordRecoveryImpactTx } from "@janusly/data";
import { and, eq, sql } from "drizzle-orm";
import { publishRunEvent } from "../run-event-stream";
import { safePersistPayload } from "../safe-persist";
import type { ApprovalTimeoutPolicy } from "../waiting-time";
import {
  asPlainObject,
  ERROR_JSON_MAX_BYTES,
  recoveryClaimPredicate,
  STATE_JSON_MAX_BYTES,
} from "./internal";
import { terminalParentNotificationMarker, type QueuePublicationClaim } from "./publication";
import { markNodeSucceededWithOutcome } from "./recovery";
import { notifyCommittedRunTerminal } from "./run";

export type NodeExecutionClaim = "claimed" | "not_claimed" | "run_failed" | "run_cancelled" | "run_terminal";

/**
 * Serialize a queued job's execution claim with parent-run recovery. The run
 * row lock closes the stale-status window: either a failed-run consumer moves
 * the exact queue generation back to durable `pending` before reattachment,
 * or reattachment reopens the run first and this same job proceeds normally.
 */
export async function claimNodeForExecution(
  runId: string,
  nodeId: string,
  attempt = 1,
  recoveryClaimToken?: string,
  publicationGeneration = 0,
): Promise<NodeExecutionClaim> {
  const createdAt = new Date();
  const eventId = crypto.randomUUID();
  const result = await db.transaction(async (tx): Promise<{ claim: NodeExecutionClaim; eventPayload?: unknown }> => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run) return { claim: "run_terminal" };

    if (run.status !== "running") {
      const claim = run.status === "failed"
        ? "run_failed"
        : run.status === "cancelled"
          ? "run_cancelled"
          : "run_terminal";
      let restoredForRecovery = false;
      if (run.status === "failed") {
        const restored = await tx
          .update(runNodes)
          .set({
            status: "pending",
            queuePublicationRepairAfter: createdAt,
          })
          .where(and(
            eq(runNodes.runId, runId),
            eq(runNodes.nodeId, nodeId),
            eq(runNodes.status, "queued"),
            sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
            recoveryClaimPredicate(recoveryClaimToken),
            eq(runNodes.queuePublicationGeneration, publicationGeneration),
          ))
          .returning({ id: runNodes.id });
        restoredForRecovery = restored.length > 0;
      }
      const eventPayload = safePersistPayload({
        reason: `Run ${run.status}`,
        attempt,
        ...(restoredForRecovery ? { restoredForRecovery: true } : {}),
      });
      await tx.insert(runEvents).values({
        id: eventId,
        runId,
        nodeId,
        type: "node.skipped",
        payload: eventPayload,
        createdAt,
      });
      return { claim, eventPayload };
    }

    const [claimed] = await tx
      .update(runNodes)
      .set({
        status: "running",
        attempts: attempt,
        startedAt: createdAt,
        queuePublicationRepairAfter: null,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "queued"),
        sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
        recoveryClaimPredicate(recoveryClaimToken),
        eq(runNodes.queuePublicationGeneration, publicationGeneration),
      ))
      .returning({ id: runNodes.id });
    return { claim: claimed ? "claimed" : "not_claimed" };
  });

  if (result.eventPayload !== undefined) {
    publishRunEvent(runId, {
      kind: "event",
      id: eventId,
      nodeId,
      type: "node.skipped",
      payload: result.eventPayload,
      createdAt: createdAt.toISOString(),
    });
  }
  return result.claim;
}

/** Retry transition owned by the currently executing replay generation. */
export async function markExecutingNodeQueued(
  runId: string,
  nodeId: string,
  attempt = 1,
  recoveryClaimToken?: string,
  delayMs = 0,
): Promise<QueuePublicationClaim | null> {
  const repairAfter = new Date(Date.now() + Math.max(0, Math.trunc(delayMs)));
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (run?.status !== "running") return null;

    const queued = await tx.update(runNodes)
      .set({
        status: "queued",
        attempts: attempt,
        queuePublicationRepairAfter: repairAfter,
        queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        attempt: runNodes.attempts,
        recoveryClaimToken: runNodes.recoveryClaimToken,
        publicationGeneration: runNodes.queuePublicationGeneration,
      });
    if (!queued[0]) return null;
    return {
      attempt: queued[0].attempt ?? attempt,
      recoveryClaimToken: queued[0].recoveryClaimToken,
      publicationGeneration: queued[0].publicationGeneration,
    };
  });
}

/** Transition a node to `waiting` (webhook / approval pause). Metadata stored under `state_json.waiting`. */
export async function markNodeWaiting(
  runId: string,
  nodeId: string,
  metadata?: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const waiting = await db.update(runNodes)
    .set({
      status: "waiting",
      stateJson: safePersistPayload({ waiting: metadata ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }),
      waitingRepairAfter: null,
    })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "running"),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return waiting.length > 0;
}

/**
 * Fail an approval only when it still waits on the exact deadline generation.
 * The deadline + pending-state predicates make manual-resume, replay, and
 * duplicate delayed-job races harmless.
 */
export async function failWaitingApprovalNode(
  runId: string,
  nodeId: string,
  expectedDeadlineAt: string,
  policy: Extract<ApprovalTimeoutPolicy, "fail" | "auto_reject">,
): Promise<boolean> {
  const finishedAt = new Date();
  const runFailedAt = new Date(finishedAt.getTime() + 1);
  const approvalEventId = crypto.randomUUID();
  const runEventId = crypto.randomUUID();
  const autoRejected = policy === "auto_reject";
  const eventType = autoRejected ? "approval.auto_rejected" : "approval.timed_out";
  const error = safePersistPayload({
    code: autoRejected ? "approval_auto_rejected" : "approval_timed_out",
    reason: autoRejected ? "Approval automatically rejected at deadline" : "Approval deadline expired",
    deadlineAt: expectedDeadlineAt,
    onTimeout: policy,
  }, { maxBytes: ERROR_JSON_MAX_BYTES });
  const eventPayload = safePersistPayload({ deadlineAt: expectedDeadlineAt, onTimeout: policy, error });

  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running") return { persisted: false, failedNodes: 0 };

    const [row] = await tx
      .update(runNodes)
      .set({ status: "failed", errorJson: error, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .returning({ id: runNodes.id });
    if (!row) return { persisted: false, failedNodes: 0 };

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "failed")));
    const failedNodes = Number(countRows[0]?.count ?? 1);
    const [flipped] = await tx
      .update(runs)
      .set({
        status: "failed",
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ id: runs.id });
    if (!flipped) throw new Error("Approval timeout lost the locked run transition");

    await tx.insert(runEvents).values({
      id: approvalEventId,
      runId,
      nodeId,
      type: eventType,
      payload: eventPayload,
      createdAt: finishedAt,
    });
    await tx.insert(runEvents).values({
      id: runEventId,
      runId,
      nodeId: null,
      type: "run.failed",
      payload: safePersistPayload({ failedNodes }),
      createdAt: runFailedAt,
    });
    return { persisted: true, failedNodes };
  });
  if (!result.persisted) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: approvalEventId,
    nodeId,
    type: eventType,
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  publishRunEvent(runId, {
    kind: "event",
    id: runEventId,
    nodeId: null,
    type: "run.failed",
    payload: safePersistPayload({ failedNodes: result.failedNodes }),
    createdAt: runFailedAt.toISOString(),
  });
  await notifyCommittedRunTerminal(runId, "failed");
  publishRunEvent(runId, { kind: "run.status", status: "failed" });
  return true;
}

/** Reassign a still-current approval checkpoint and record one escalation event. */
export async function escalateWaitingApprovalNode(
  runId: string,
  nodeId: string,
  expectedDeadlineAt: string,
  escalateTo: string,
): Promise<boolean> {
  const escalatedAt = new Date();
  const eventId = crypto.randomUUID();
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running") return null;

    const rows = await tx
      .select({ stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .limit(1);
    const state = asPlainObject(rows[0]?.stateJson);
    const waiting = asPlainObject(state?.waiting);
    if (!waiting) return null;
    const previousAssignee = typeof waiting.assignee === "string" && waiting.assignee.trim()
      ? waiting.assignee.trim()
      : undefined;
    const nextWaiting = {
      ...waiting,
      assignee: escalateTo,
      timeoutState: "escalated",
      escalatedAt: escalatedAt.toISOString(),
      ...(previousAssignee ? { escalatedFrom: previousAssignee } : {}),
    };
    const [updated] = await tx
      .update(runNodes)
      .set({ stateJson: safePersistPayload({ ...state, waiting: nextWaiting }, { maxBytes: STATE_JSON_MAX_BYTES }) })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .returning({ id: runNodes.id });
    if (!updated) return null;
    const eventPayload = safePersistPayload({
      deadlineAt: expectedDeadlineAt,
      assignee: escalateTo,
      ...(previousAssignee ? { previousAssignee } : {}),
      waiting: nextWaiting,
    });
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "approval.escalated",
      payload: eventPayload,
      createdAt: escalatedAt,
    });
    return eventPayload;
  });
  if (!result) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "approval.escalated",
    payload: result,
    createdAt: escalatedAt.toISOString(),
  });
  return true;
}

/** Mark a node skipped (e.g. edge condition false). Terminal — `finishedAt` set. */
export async function markNodeSkipped(runId: string, nodeId: string, reason?: any) {
  await db.update(runNodes)
    .set({ status: "skipped", stateJson: safePersistPayload({ skipped: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node succeeded; `output` lands under `state_json.output` (the web Inspector reads from there). */
export async function markNodeSucceeded(
  runId: string,
  nodeId: string,
  output?: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const finishedAt = new Date();
  const completed = await db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;
    await recordRecoveryImpactTx(tx, {
      deadLetterId: completed?.deadLetterId ?? null,
      userId: completed?.userId ?? null,
      playbookId: completed?.playbookId ?? null,
      validationRunId: completed?.validationRunId ?? null,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
  return completed;
}

/**
 * Combine the `succeeded` node transition and its `node.succeeded` event in
 * ONE transaction. The two writes on the hottest completion path — an UPDATE
 * of `run_nodes` and an INSERT into `run_events` — commit or roll back
 * together and cost one DB round-trip instead of two. The SSE publish happens
 * AFTER commit so a rolled-back write never fans out to live subscribers.
 *
 * The event payload does NOT repeat a large output (which already lives in the
 * node row's `state_json`) — see `NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES`.
 */
export async function markNodeSucceededWithEvent(
  runId: string,
  nodeId: string,
  output: unknown,
  attempt: number,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const result = await markNodeSucceededWithOutcome(
    runId,
    nodeId,
    output,
    attempt,
    [],
    recoveryClaimToken,
  );
  return result.completed;
}

/** Conditionally complete a paused node. Returns false when it was already resumed/cancelled/failed. */
export async function markWaitingNodeSucceeded(runId: string, nodeId: string, output?: any): Promise<boolean> {
  const finishedAt = new Date();
  return db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt })
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId), eq(runNodes.status, "waiting")))
      .returning({
        id: runNodes.id,
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;
    await recordRecoveryImpactTx(tx, {
      deadLetterId: completed.deadLetterId,
      userId: completed.userId,
      playbookId: completed.playbookId,
      validationRunId: completed.validationRunId,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
}

/** Mark a node failed with the serialized error in `error_json`. Terminal. */
export async function markNodeFailed(runId: string, nodeId: string, error: any) {
  await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Fail only the execution generation that still owns the running row. */
export async function markExecutingNodeFailed(
  runId: string,
  nodeId: string,
  error: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const failed = await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "running"),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return failed.length > 0;
}
