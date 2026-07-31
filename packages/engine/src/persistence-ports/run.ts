/** Run reads, replay transitions, subworkflow handoff, and terminal rollup. */

import { db, deadLetters, runEvents, runNodes, runs, workflowVersions } from "@janusly/db";
import { recordRecoveryImpactTx, recordWorkflowRolloutOutcome } from "@janusly/data";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { isOpenNodeStatus, nodeCancellableStatusValues } from "@janusly/shared/src/status";
import { projectOutputs } from "../outputs-projector";
import { publishRunEvent } from "../run-event-stream";
import { safePersistPayload } from "../safe-persist";
import { appendEvent } from "./event";
import {
  asPlainObject,
  CHILD_ERROR_MAX_BYTES,
  CHILD_MESSAGE_MAX_CHARS,
  ERROR_JSON_MAX_BYTES,
  projectRunContext,
  STATE_JSON_MAX_BYTES,
} from "./internal";
import { markParentNotificationSucceeded, terminalParentNotificationMarker } from "./publication";

/** Return the current top-level run status, or `null` when the row is absent. */
export async function getRunStatus(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0]?.status ?? null;
}

/**
 * Load the raw workflow snapshot a run executes against, from
 * `runs.inputJson.workflow`. This is the AUTHORITATIVE per-run workflow:
 * `startRun` writes it, the sandbox / replay-lab / validation creators write
 * it, and `claimReplayTransition` atomically updates it with the replay claim
 * so a patched replay's downstream cascade runs against the patched DAG. The
 * worker reloads it per node job instead of shipping the full workflow in
 * every Redis job payload.
 *
 * Returns `found: false` when the run row is absent (deleted between enqueue
 * and execution — the worker treats it as a benign no-op, mirroring the
 * pre-slim "claim fails → skip" outcome). `workflow` is the raw JSON value
 * (parsed by the caller through the content-addressed `parseWorkflowCached`).
 */
export async function loadRunWorkflowRaw(runId: string): Promise<{ found: boolean; workflow: unknown }> {
  const rows = await db.select({ inputJson: runs.inputJson }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!rows[0]) return { found: false, workflow: undefined };
  const inputJson = rows[0].inputJson as { workflow?: unknown } | null;
  return { found: true, workflow: inputJson && typeof inputJson === "object" ? inputJson.workflow : undefined };
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

export type RunNodeWaitingSnapshot = {
  status: string;
  waiting: Record<string, unknown> | null;
};

/** Load the narrow status + waiting metadata projection used by delayed jobs. */
export async function getRunNodeWaitingSnapshot(
  runId: string,
  nodeId: string,
): Promise<RunNodeWaitingSnapshot | null> {
  const rows = await db
    .select({ status: runNodes.status, stateJson: runNodes.stateJson })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const state = asPlainObject(row.stateJson);
  return {
    status: row.status,
    waiting: asPlainObject(state?.waiting),
  };
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

/** Stable per-run metadata loaded once at runtime entry: org scope, the
 *  active workflow-version pointer, the workflow id (resolved through the
 *  versions table), and the user who started the run. */
export type RunMetadata = {
  orgId: string;
  workflowVersionId: string;
  workflowId: string | null;
  createdBy: string | null;
  /** `runs.replayMode` — `"validation"` for sandbox/dry-run replays, `null`
   *  for production runs. Optional so existing `ExecutionStore` mocks that
   *  omit it stay valid. `executeNode` reads it to set `NodeContext.dryRun`
   *  without a second per-node `runs` lookup. */
  replayMode?: string | null;
  /** Validation-only effect policy persisted in `runs.inputJson`. */
  validationEffectMode?: "skip" | "provider_simulation";
  /** The run's start/trigger input (`runs.inputJson.input` — the block
   *  `startRun` persists and the trigger-ingest routes fill with the inbound
   *  event). `executeNode` merges it into the per-node context as
   *  `context.input` so trigger executors and `{{context.input.*}}`
   *  templates can read it. This keeps production trigger execution aligned
   *  with sandbox validation, which also receives the run input.
   *  Optional so existing mocks that omit it stay valid. */
  input?: Record<string, unknown>;
  /** Unresolved-template policy from the immutable workflow snapshot stored
   *  in `runs.inputJson.workflow`. Missing legacy values are lenient. */
  templatePolicy?: "lenient" | "strict";
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
      replayMode: runs.replayMode,
      inputJson: runs.inputJson,
    })
    .from(runs)
    .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // `inputJson` is `{ workflow, input }` for production runs (`startRun`) and
  // `{ workflow, failingNodeId }` for sandbox validation runs — read `input`
  // defensively and normalise anything non-object to `{}`.
  const inputJson = row.inputJson as {
    input?: unknown;
    workflow?: unknown;
    validationEffectMode?: unknown;
  } | null;
  const rawInput = inputJson?.input;
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const rawWorkflow = inputJson?.workflow;
  const rawTemplatePolicy = rawWorkflow && typeof rawWorkflow === "object" && !Array.isArray(rawWorkflow)
    ? (rawWorkflow as Record<string, unknown>).templatePolicy
    : undefined;
  const templatePolicy = rawTemplatePolicy === "strict" || rawTemplatePolicy === "lenient"
    ? rawTemplatePolicy
    : undefined;
  const validationEffectMode = inputJson?.validationEffectMode === "provider_simulation"
    ? "provider_simulation"
    : "skip";
  return {
    orgId: row.orgId,
    workflowVersionId: row.workflowVersionId,
    workflowId: row.workflowId ?? null,
    createdBy: row.createdBy ?? null,
    replayMode: row.replayMode ?? null,
    validationEffectMode,
    input,
    templatePolicy,
  };
}

/** Cancel a run + every still-open node, append a `run.cancelled` event. */
export async function cancelRun(runId: string, reason?: any) {
  await db.update(runs)
    .set({
      status: "cancelled",
      parentNotificationAfter: terminalParentNotificationMarker(),
    })
    .where(eq(runs.id, runId));

  await db.update(runNodes)
    .set({ status: "cancelled", stateJson: safePersistPayload({ cancelled: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    // `running` is intentionally excluded — running nodes finish naturally;
    // the runtime's post-success guard then skips downstream scheduling.
    .where(and(eq(runNodes.runId, runId), inArray(runNodes.status, [...nodeCancellableStatusValues])));

  await appendEvent(runId, null, "run.cancelled", reason ?? {});
  // Subworkflow children: a cancelled child still notifies the parent so the
  // parent's subworkflow node fails (the parent decides whether to roll up).
  await notifyCommittedRunTerminal(runId, "cancelled");
  publishRunEvent(runId, { kind: "run.status", status: "cancelled" });
}

/**
 * Thrown by `claimReplayTransition` when the run/node is NOT in a replayable
 * state, so the `/dlq/replay` route can map it to a 409 (explicit operator
 * feedback) instead of the earlier silent no-op that left the operator
 * believing a replay started when it hadn't.
 */
export class ReplayNotClaimableError extends Error {
  constructor(readonly reason: "run_not_replayable" | "node_mid_retry") {
    super(`Replay not claimable: ${reason}`);
    this.name = "ReplayNotClaimableError";
  }
}

/**
 * Atomically un-terminate a failed run, replace its authoritative workflow
 * snapshot, and reset its failed node to the queue outbox in ONE transaction.
 * Replaces the former pair of separate awaits
 * (`resetRunForReplay` + `markNodeQueued`) whose gap let a
 * cancellation land between them — leaving a `queued` node on a `cancelled`
 * run that the runtime guard skips forever while the operator believes the
 * replay started (silent false recovery).
 *
 * Semantics (throws `ReplayNotClaimableError`, which rolls the tx back so no
 * partial state survives):
 * - Flips `failed → running` (idempotent no-op when the run is already
 *   `running` — the multi-dead-letter-same-run case: a sibling DLQ replay
 *   flipped it first, and this one still claims its own node).
 * - Reads the run status back INSIDE the tx: anything other than `running`
 *   (cancelled / succeeded / deleted) → `run_not_replayable`. NOTE this is a
 *   deliberate behaviour change from the earlier path, which would silently
 *   queue a node on a non-`failed` run (and, for a `succeeded` run, actually
 *   re-run it).
 * - If the failed node is already `queued` (mid engine-retry, an in-flight
 *   BullMQ job) → `node_mid_retry`, so a manual replay can't stomp the
 *   snapshot the in-flight retry reads or double-fire its side effect.
 *
 * The caller only publishes the deterministic BullMQ job AFTER a successful
 * claim; a rejected claim mutates neither the snapshot nor the queue, while a
 * crash before publication leaves the durable repair marker behind.
 */
export type ReplayTransitionClaim = {
  recoveryClaimToken: string;
  publicationGeneration: number;
};

export async function claimReplayTransition(
  runId: string,
  nodeId: string,
  recovery: {
    recoveryClaimToken?: string;
    deadLetterId?: string | null;
    recoveryActorId?: string | null;
    recoveryPlaybookId?: string | null;
    recoveryValidationRunId?: string | null;
  } = {},
  workflow?: Workflow,
): Promise<ReplayTransitionClaim> {
  const recoveryClaimToken = recovery.recoveryClaimToken ?? crypto.randomUUID();
  const replayClaimedAt = new Date();
  const publicationGeneration = await db.transaction(async (tx) => {
    await tx.update(runs)
      .set({ status: "running", parentNotificationAfter: null })
      .where(and(eq(runs.id, runId), eq(runs.status, "failed")));

    const runRows = await tx
      .select({ status: runs.status, inputJson: runs.inputJson })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (runRows[0]?.status !== "running") throw new ReplayNotClaimableError("run_not_replayable");

    if (workflow) {
      const currentInput = runRows[0].inputJson && typeof runRows[0].inputJson === "object"
        ? runRows[0].inputJson as Record<string, unknown>
        : {};
      await tx
        .update(runs)
        .set({ inputJson: { ...currentInput, workflow } })
        .where(eq(runs.id, runId));
    }

    const nodeRows = await tx
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
      .limit(1);
    if (nodeRows[0]?.status !== "failed") throw new ReplayNotClaimableError("node_mid_retry");

    if (recovery.deadLetterId) {
      const [claimedDeadLetter] = await tx
        .update(deadLetters)
        .set({ replayClaimToken: recoveryClaimToken, replayClaimedAt })
        .where(and(
          eq(deadLetters.id, recovery.deadLetterId),
          eq(deadLetters.runId, runId),
          eq(deadLetters.nodeId, nodeId),
          eq(deadLetters.status, "open"),
        ))
        .returning({ id: deadLetters.id });
      if (!claimedDeadLetter) throw new ReplayNotClaimableError("node_mid_retry");
    }

    const claimed = await tx.update(runNodes)
      .set({
        status: "queued",
        attempts: 1,
        recoveryDeadLetterId: recovery.deadLetterId ?? null,
        recoveryRequestedBy: recovery.recoveryActorId ?? null,
        recoveryClaimToken,
        recoveryPlaybookId: recovery.recoveryPlaybookId ?? null,
        recoveryValidationRunId: recovery.recoveryValidationRunId ?? null,
        queuePublicationRepairAfter: replayClaimedAt,
        queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "failed"),
      ))
      .returning({ publicationGeneration: runNodes.queuePublicationGeneration });
    if (claimed.length === 0) throw new ReplayNotClaimableError("node_mid_retry");
    return claimed[0]!.publicationGeneration;
  });
  return { recoveryClaimToken, publicationGeneration };
}

/**
 * Complete only the paused subworkflow node that still waits on
 * `expectedChildRunId`. The child-generation predicate prevents a late child
 * from consuming the recovery claim or output of a newer replay generation.
 */
export async function completeWaitingSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  output: unknown,
): Promise<boolean> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const eventPayload = safePersistPayload({ childRunId: expectedChildRunId, childOutput: output ?? {} });
  const completed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(runNodes)
      .set({
        status: "succeeded",
        stateJson: safePersistPayload({
          output: output ?? {},
          subworkflow: { childRunId: expectedChildRunId },
        }, { maxBytes: STATE_JSON_MAX_BYTES }),
        finishedAt,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = 'succeeded'
        )`,
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!row) return false;
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.subworkflow.completed",
      payload: eventPayload,
      createdAt: finishedAt,
    });
    await recordRecoveryImpactTx(tx, {
      deadLetterId: row.deadLetterId,
      userId: row.userId,
      playbookId: row.playbookId,
      validationRunId: row.validationRunId,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
  if (!completed) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.subworkflow.completed",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  return true;
}

/** Fail only a paused subworkflow node that still belongs to this child run. */
export async function failWaitingSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  childStatus: "failed" | "cancelled",
  childFailure?: { nodeId: string; error: unknown } | null,
): Promise<boolean> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const persistedChildError = childFailure
    ? safePersistPayload(childFailure.error, { maxBytes: CHILD_ERROR_MAX_BYTES })
    : undefined;
  const originalChildError = asPlainObject(childFailure?.error);
  const rawChildMessage = typeof originalChildError?.message === "string"
    ? originalChildError.message
    : typeof originalChildError?.reason === "string"
      ? originalChildError.reason
      : undefined;
  const childMessage = rawChildMessage?.slice(0, CHILD_MESSAGE_MAX_CHARS);
  const error = safePersistPayload({
    reason: `Subworkflow ${childStatus}`,
    message: childMessage ?? `Subworkflow ${childStatus}`,
    childRunId: expectedChildRunId,
    ...(childFailure ? {
      childNodeId: childFailure.nodeId,
      childError: persistedChildError,
    } : {}),
  }, { maxBytes: ERROR_JSON_MAX_BYTES });
  const eventPayload = safePersistPayload({
    childRunId: expectedChildRunId,
    childStatus,
    ...(childFailure ? { childNodeId: childFailure.nodeId } : {}),
  });
  const failed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(runNodes)
      .set({ status: "failed", errorJson: error, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = ${childStatus}
        )`,
      ))
      .returning({ id: runNodes.id });
    if (!row) return false;
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.subworkflow.failed",
      payload: eventPayload,
      createdAt: finishedAt,
    });
    return true;
  });
  if (!failed) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.subworkflow.failed",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  return true;
}

export type ReattachSubworkflowResult = {
  completed: boolean;
  reopened: boolean;
  readyToContinue: boolean;
  remainingFailedNodes: number;
};

/**
 * Reattach a successfully replayed child to the exact failed parent-node
 * generation that still references it. The parent row lock serializes this
 * recovery against cancellation and sibling replays. A failed parent reopens
 * only when the repaired subworkflow node was its last failure; an already
 * running parent can retain the repair after another replay won first.
 *
 * This is intentionally NOT a recovery-impact writer. The child's replay
 * already owns the impact claim; crediting the parent would double-count one
 * operator action as two recovered nodes.
 */
export async function reattachFailedSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  output: unknown,
): Promise<ReattachSubworkflowResult> {
  const completedAt = new Date();
  const nodeEventId = crypto.randomUUID();
  const runEventId = crypto.randomUUID();
  const result = await db.transaction(async (tx): Promise<ReattachSubworkflowResult> => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || (run.status !== "failed" && run.status !== "running")) {
      return { completed: false, reopened: false, readyToContinue: false, remainingFailedNodes: 0 };
    }

    const [completed] = await tx
      .update(runNodes)
      .set({
        status: "succeeded",
        stateJson: safePersistPayload({
          output: output ?? {},
          subworkflow: { childRunId: expectedChildRunId },
        }, { maxBytes: STATE_JSON_MAX_BYTES }),
        errorJson: null,
        finishedAt: completedAt,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "failed"),
        sql`${runNodes.errorJson} #>> '{childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = 'succeeded'
        )`,
      ))
      .returning({ id: runNodes.id });
    if (!completed) {
      return { completed: false, reopened: false, readyToContinue: false, remainingFailedNodes: 0 };
    }

    // A sibling child may already be terminally failed while its durable
    // handoff still has the parent node in `waiting`. Count that exact pending
    // failure too, otherwise repairing this node could reopen the parent and
    // publish successors before the sibling handoff makes it failed again.
    // Both states share one statement snapshot so a concurrent
    // `waiting → failed` handoff cannot move between separate counts.
    const blockingRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(runNodes)
      .where(and(
        eq(runNodes.runId, runId),
        or(
          eq(runNodes.status, "failed"),
          and(
            eq(runNodes.status, "waiting"),
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'subworkflow'`,
            sql`EXISTS (
              SELECT 1 FROM ${runs} AS child_run
              WHERE child_run.id = ${runNodes.stateJson} #>> '{waiting,childRunId}'
                AND child_run.status IN ('failed', 'cancelled')
            )`,
          ),
        ),
      ));
    const remainingFailedNodes = Number(blockingRows[0]?.count ?? 0);
    const readyToContinue = remainingFailedNodes === 0;
    const reopened = run.status === "failed" && readyToContinue;
    if (reopened) {
      const [runReopened] = await tx
        .update(runs)
        .set({ status: "running", parentNotificationAfter: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "failed")))
        .returning({ id: runs.id });
      if (!runReopened) throw new Error("Subworkflow reattachment lost the locked parent transition");
    }

    if (readyToContinue) {
      // Reopening changes DAG readiness inside this transaction. Mark every
      // still-pending row before commit so a crash before the notifier's
      // immediate readiness scan remains recoverable. Scanning the whole DAG
      // is intentional: when several failed sibling subworkflows recover, the
      // last repair can unblock successors of any earlier sibling, not only
      // nodes directly downstream of this one.
      await tx
        .update(runNodes)
        .set({ queuePublicationRepairAfter: completedAt })
        .where(and(
          eq(runNodes.runId, runId),
          eq(runNodes.status, "pending"),
          isNull(runNodes.queuePublicationRepairAfter),
        ));
    }

    const nodeEventPayload = safePersistPayload({
      childRunId: expectedChildRunId,
      childOutput: output ?? {},
      reopened,
      remainingFailedNodes,
    });
    await tx.insert(runEvents).values({
      id: nodeEventId,
      runId,
      nodeId,
      type: "node.subworkflow.reattached",
      payload: nodeEventPayload,
      createdAt: completedAt,
    });
    if (reopened) {
      await tx.insert(runEvents).values({
        id: runEventId,
        runId,
        nodeId: null,
        type: "run.reopened",
        payload: safePersistPayload({ reason: "subworkflow_recovered", childRunId: expectedChildRunId }),
        createdAt: completedAt,
      });
    }

    return { completed: true, reopened, readyToContinue, remainingFailedNodes };
  });

  if (!result.completed) return result;
  publishRunEvent(runId, {
    kind: "event",
    id: nodeEventId,
    nodeId,
    type: "node.subworkflow.reattached",
    payload: safePersistPayload({
      childRunId: expectedChildRunId,
      childOutput: output ?? {},
      reopened: result.reopened,
      remainingFailedNodes: result.remainingFailedNodes,
    }),
    createdAt: completedAt.toISOString(),
  });
  if (result.reopened) {
    publishRunEvent(runId, {
      kind: "event",
      id: runEventId,
      nodeId: null,
      type: "run.reopened",
      payload: safePersistPayload({ reason: "subworkflow_recovered", childRunId: expectedChildRunId }),
      createdAt: completedAt.toISOString(),
    });
    publishRunEvent(runId, { kind: "run.status", status: "running" });
  }
  return result;
}

/**
 * Subworkflow terminal-notifier hook. `subworkflow.ts` registers its
 * `notifyParentOnTerminal` here at module load via `setSubworkflowNotifier`
 * — this module then calls it after a terminal status flip, without importing
 * `subworkflow.ts` directly (which would create an import cycle).
 */
type SubworkflowNotifier = (
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
) => Promise<boolean>;
let subworkflowNotifier: SubworkflowNotifier | null = null;

/** Wire the subworkflow notifier. Called from `subworkflow.ts` once at module load. */
export function setSubworkflowNotifier(notifier: SubworkflowNotifier | null): void {
  subworkflowNotifier = notifier;
}

export async function notifyCommittedRunTerminal(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  expectedMarker?: Date,
): Promise<boolean> {
  try {
    await recordWorkflowRolloutOutcome(runId, status);
  } catch (error) {
    // Rollout evidence and automatic rollback are durable operational
    // sidecars. A transient observer failure must never unwind a terminal run;
    // the maintenance reconciler can safely retry because outcomes are keyed
    // by run id.
    console.warn("[workflow-rollout] terminal outcome recording failed", { runId, status, error });
  }
  try {
    let marker = expectedMarker;
    if (!marker) {
      const [run] = await db
        .select({
          status: runs.status,
          parentRunId: runs.parentRunId,
          parentNodeId: runs.parentNodeId,
          parentNotificationAfter: runs.parentNotificationAfter,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!run || run.status !== status) return false;
      if (!run.parentRunId || !run.parentNodeId) return true;
      if (!run.parentNotificationAfter) return false;
      marker = run.parentNotificationAfter;
    }
    if (!subworkflowNotifier) return false;
    const delivered = await subworkflowNotifier(runId, status);
    if (!delivered) return false;
    return await markParentNotificationSucceeded(runId, status, marker);
  } catch {
    // Notifier failures are isolated by `subworkflow.ts` itself; this is a
    // defense-in-depth catch so a runaway throw can't take down the
    // status-flip caller.
    return false;
  }
}

/** Roll up node statuses to the run-level status. Cancelled stays cancelled; any failed → failed; all-terminal → succeeded; otherwise running. */
export async function updateRunStatusFromNodes(runId: string) {
  const status = await getRunStatus(runId);
  if (status === "cancelled" || status === "succeeded" || status === "failed" || status === "timed_out") {
    return status;
  }

  // Status-only projection: this rollup runs after every node completion,
  // and the full rows would drag each node's state_json (up to 1MB) over
  // the wire just to inspect the status column.
  const nodes = await db
    .select({ status: runNodes.status })
    .from(runNodes)
    .where(eq(runNodes.runId, runId));

  if (nodes.some(node => node.status === "failed")) {
    // Conditional flip: only the worker that actually transitions running→failed
    // appends the persisted `run.failed` timeline row + notifies. Under multiple
    // workers two node-completions can race into this branch; the `ne(status)`
    // guard means the loser's UPDATE affects 0 rows and it skips the append.
    const flipped = await db.update(runs)
      .set({
        status: "failed",
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), ne(runs.status, "failed")))
      .returning({ id: runs.id });
    if (flipped.length > 0) {
      await appendEvent(runId, null, "run.failed", {
        failedNodes: nodes.filter(node => node.status === "failed").length,
      });
      await notifyCommittedRunTerminal(runId, "failed");
    }
    publishRunEvent(runId, { kind: "run.status", status: "failed" });
    return "failed";
  }

  if (nodes.length > 0 && nodes.every(node => !isOpenNodeStatus(node.status))) {
    // Project the workflow's declared `outputs` (if any) into runs.outputJson
    // BEFORE flipping status, so a single UPDATE carries both writes. Same
    // conditional-flip guard as the failed branch: only the transitioning
    // worker appends the persisted `run.succeeded` row.
    const outputJson = await computeRunOutputs(runId);
    const flipped = await db.update(runs)
      .set({
        status: "succeeded",
        outputJson,
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), ne(runs.status, "succeeded")))
      .returning({ id: runs.id });
    if (flipped.length > 0) {
      await appendEvent(runId, null, "run.succeeded", { nodes: nodes.length });
      await notifyCommittedRunTerminal(runId, "succeeded");
    }
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

/**
 * Build the per-run context dict (`{ [nodeId]: { status, output, ... } }`)
 * every executor receives.
 *
 * `statusesOnly: true` skips the `state_json` / `error_json` columns — the
 * readiness scan in `enqueueReadyNodes` only needs statuses unless an edge
 * carries a `condition`, and full rows drag each node's state (up to 1MB)
 * over the wire on every completion. The reduced shape keeps the same keys
 * (empty `state`/`output`, `null` error) so consumers stay structurally
 * compatible; don't hand it to executors that template over outputs.
 */
export async function getRunContext(runId: string, opts: { statusesOnly?: boolean } = {}) {
  if (opts.statusesOnly) {
    const rows = await db
      .select({ nodeId: runNodes.nodeId, status: runNodes.status, attempts: runNodes.attempts })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    return rows.reduce<Record<string, any>>((acc, row) => {
      acc[row.nodeId] = {
        status: row.status,
        attempts: row.attempts ?? 0,
        state: {},
        output: {},
        error: null,
      };
      return acc;
    }, {});
  }

  const rows = await db
    .select({
      nodeId: runNodes.nodeId,
      status: runNodes.status,
      attempts: runNodes.attempts,
      stateJson: runNodes.stateJson,
      errorJson: runNodes.errorJson,
    })
    .from(runNodes)
    .where(eq(runNodes.runId, runId));

  return projectRunContext(rows);
}
