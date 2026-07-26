/**
 * `startRun` — bootstrap one run of a workflow.
 *
 * Wraps the `runs` insert + the batch `runNodes` insert + the `run.started`
 * event in a single Drizzle transaction. AGENTS.md invariant: don't split
 * this back into per-node inserts — the atomicity is what guarantees a
 * partially-started run never escapes to the queue.
 *
 * Used by:
 * - `apps/api/src/routes/runs-routes.ts` `POST /start` — primary caller.
 * - `apps/api/src/routes/trigger-ingest-routes.ts` — inbound event starts and
 *   claimed-event backfill.
 * - `packages/engine/src/resume-run.ts` — for restart-from-checkpoint paths.
 *
 * Invariants:
 * - One transaction; all inserts succeed or none do.
 * - Distinct `run.started` vs `run.started.adhoc` audit events depending on
 *   whether the workflow was persisted. The split keeps audit
 *   readers honest about which runs came from saved DAGs.
 * - An inbound trigger event, when supplied, becomes `started` in the same
 *   transaction as its run so a process crash cannot duplicate or lose it.
 */

import { db, runs, runNodes, runEvents, triggerEvents } from "@janusly/db";
import { and, eq, isNull } from "drizzle-orm";
import { publishInitialNode } from "./initial-node-publication";
import { publishRunEvent } from "./run-event-stream";
import { safePersistPayload } from "./safe-persist";
import type { Workflow } from "@janusly/shared";
import { applyInputDefaults, validateInputs, WorkflowInputValidationError } from "./inputs-validator";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

export type ParentSubworkflowCheckpoint = {
  /** Waiting metadata known before the child id and checkpoint clock are allocated. */
  waitingMetadata: Record<string, unknown>;
  /** Payload for `node.subworkflow.started`, excluding the generated child id. */
  startedEventPayload: Record<string, unknown>;
  /** Active replay generation for an exact parent-node CAS. */
  recoveryClaimToken?: string;
};

export type StartableWorkflow = Workflow & {
  orgId?: string;
  createdBy?: string | null;
  input?: unknown;
  versionId?: string;
  /** Server-owned canary assignment captured once; retries never recalculate it. */
  rollout?: { id: string; variant: "baseline" | "canary" };
  /**
   * Subworkflow linkage. When present, this run was spawned by a
   * `subworkflow` node in the parent run. Used by `notifyParentOnTerminal`
   * to resume the parent's node when the child terminates.
   */
  parentRunId?: string;
  parentNodeId?: string;
  /** Atomically pauses the spawning parent before this child's roots can publish. */
  parentCheckpoint?: ParentSubworkflowCheckpoint;
  /** Inherited sandbox posture for subworkflows spawned by validation runs. */
  replayMode?: "validation" | null;
  /** OTel trace id shared across a subworkflow chain. Inherited from the parent or generated lazily. */
  traceId?: string;
  /** Exact inbound event consumed atomically with run creation. */
  triggerEventStart?: { id: string; claimToken?: string };
};

/** The event was already consumed or moved to a non-startable state. */
export class TriggerEventStartConflictError extends Error {
  constructor() {
    super("Trigger event is no longer startable");
    this.name = "TriggerEventStartConflictError";
  }
}

export async function startRun(workflow: StartableWorkflow) {
  // When the workflow declares typed `inputs`, fill declared defaults and then
  // validate the run-start payload before any DB write, so a malformed run
  // never enters the queue. Throws `WorkflowInputValidationError` — the API
  // route catches and returns 400.
  //
  // Defaults resolve HERE rather than at template time so `runs.inputJson`
  // records the values the run actually used: a later reader (run detail,
  // replay, evidence export) sees the effective configuration even after the
  // workflow's defaults change. It is also what lets a trigger-driven
  // workflow declare inputs — its payload carries the event, never the
  // declared fields.
  const resolvedInput = workflow.inputs
    ? applyInputDefaults(workflow.inputs, workflow.input ?? {})
    : workflow.input ?? {};
  if (workflow.inputs) {
    const result = validateInputs(workflow.inputs, resolvedInput);
    if (!result.valid) throw new WorkflowInputValidationError(result.errors);
  }

  const runId = crypto.randomUUID();
  const workflowVersionId = workflow.versionId ?? workflow.id ?? runId;
  const startNodeIds = new Set(
    workflow.nodes
      .filter((node) => !workflow.edges.some((edge) => edge.to === node.id))
      .map((node) => node.id),
  );
  const publicationMarkedAt = new Date();
  const parentCheckpointAt = new Date();
  const parentStartedEventId = workflow.parentCheckpoint ? crypto.randomUUID() : null;
  const parentWaitingEventId = workflow.parentCheckpoint ? crypto.randomUUID() : null;
  const parentWaitingMetadata = workflow.parentCheckpoint
    ? {
        ...workflow.parentCheckpoint.waitingMetadata,
        childRunId: runId,
        waitingSince: parentCheckpointAt.toISOString(),
      }
    : undefined;
  const parentStartedEventPayload = workflow.parentCheckpoint
    ? safePersistPayload({
        ...workflow.parentCheckpoint.startedEventPayload,
        childRunId: runId,
      })
    : undefined;
  const parentWaitingEventPayload = parentWaitingMetadata
    ? safePersistPayload({
        status: "waiting",
        reason: "Waiting for subworkflow",
        metadata: parentWaitingMetadata,
      })
    : undefined;
  const {
    parentCheckpoint: _parentCheckpoint,
    replayMode: _replayMode,
    rollout: _rollout,
    triggerEventStart: _triggerEventStart,
    ...workflowSnapshot
  } = workflow;

  // Persist run + all nodes + the run.started event in one transaction so a
  // crash mid-setup cannot leave a partially-initialized run. Subworkflow
  // callers also checkpoint the parent in this transaction, before any child
  // root can reach BullMQ.
  await db.transaction(async (tx) => {
    if (workflow.parentCheckpoint) {
      if (!workflow.parentRunId || !workflow.parentNodeId) {
        throw new Error("A parent subworkflow checkpoint requires parentRunId and parentNodeId");
      }
      const [parentRun] = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, workflow.parentRunId))
        .limit(1)
        .for("update");
      if (parentRun?.status !== "running") {
        throw new Error("Parent run is no longer active for subworkflow start");
      }
      const recoveryPredicate = workflow.parentCheckpoint.recoveryClaimToken
        ? eq(runNodes.recoveryClaimToken, workflow.parentCheckpoint.recoveryClaimToken)
        : isNull(runNodes.recoveryClaimToken);
      const [checkpointed] = await tx
        .update(runNodes)
        .set({
          status: "waiting",
          stateJson: safePersistPayload(
            { waiting: parentWaitingMetadata ?? {} },
            { maxBytes: INITIAL_NODE_STATE_MAX_BYTES },
          ),
          waitingRepairAfter: null,
        })
        .where(and(
          eq(runNodes.runId, workflow.parentRunId),
          eq(runNodes.nodeId, workflow.parentNodeId),
          eq(runNodes.status, "running"),
          recoveryPredicate,
        ))
        .returning({ id: runNodes.id });
      if (!checkpointed) {
        throw new Error("Parent subworkflow node is no longer claimable");
      }
    }

    await tx.insert(runs).values({
      id: runId,
      orgId: workflow.orgId ?? "default",
      workflowVersionId,
      workflowRolloutId: workflow.rollout?.id ?? null,
      workflowRolloutVariant: workflow.rollout?.variant ?? null,
      status: "running",
      createdBy: workflow.createdBy ?? null,
      inputJson: { workflow: workflowSnapshot, input: resolvedInput },
      parentRunId: workflow.parentRunId ?? null,
      parentNodeId: workflow.parentNodeId ?? null,
      parentLinkKind: workflow.parentCheckpoint ? "subworkflow" : null,
      replayMode: workflow.replayMode ?? null,
      // Every root run gets a correlation id up front; subworkflows pass the
      // inherited value so the whole chain remains copyable as one trace.
      traceId: workflow.traceId ?? crypto.randomUUID(),
    });

    if (workflow.triggerEventStart) {
      const eventStatusPredicate = workflow.triggerEventStart.claimToken
        ? and(
            eq(triggerEvents.status, "backfilling"),
            eq(triggerEvents.backfillClaimToken, workflow.triggerEventStart.claimToken),
          )
        : and(eq(triggerEvents.status, "received"), isNull(triggerEvents.runId));
      const [claimedEvent] = await tx
        .update(triggerEvents)
        .set({
          status: "started",
          runId,
          skippedReason: null,
          backfillClaimToken: null,
          backfillClaimedAt: null,
        })
        .where(and(
          eq(triggerEvents.orgId, workflow.orgId ?? "default"),
          eq(triggerEvents.id, workflow.triggerEventStart.id),
          eventStatusPredicate,
        ))
        .returning({ id: triggerEvents.id });
      if (!claimedEvent) throw new TriggerEventStartConflictError();
    }

    if (workflow.nodes.length > 0) {
      await tx.insert(runNodes).values(workflow.nodes.map((node) => {
        const startsQueued = startNodeIds.has(node.id);
        return {
          id: crypto.randomUUID(),
          runId,
          nodeId: node.id,
          status: startsQueued ? ("queued" as const) : ("pending" as const),
          stateJson: safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
          attempts: startsQueued ? 1 : 0,
          queuePublicationRepairAfter: startsQueued ? publicationMarkedAt : null,
          queuePublicationGeneration: startsQueued ? 1 : 0,
        };
      }));
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started",
      payload: safePersistPayload({ workflowVersionId }),
    });

    if (
      workflow.parentCheckpoint
      && workflow.parentRunId
      && workflow.parentNodeId
      && parentStartedEventId
      && parentWaitingEventId
      && parentStartedEventPayload
      && parentWaitingEventPayload
    ) {
      await tx.insert(runEvents).values([
        {
          id: parentStartedEventId,
          runId: workflow.parentRunId,
          nodeId: workflow.parentNodeId,
          type: "node.subworkflow.started",
          payload: parentStartedEventPayload,
          createdAt: parentCheckpointAt,
        },
        {
          id: parentWaitingEventId,
          runId: workflow.parentRunId,
          nodeId: workflow.parentNodeId,
          type: "node.waiting",
          payload: parentWaitingEventPayload,
          createdAt: new Date(parentCheckpointAt.getTime() + 1),
        },
      ]);
    }
  });

  if (
    workflow.parentRunId
    && workflow.parentNodeId
    && parentStartedEventId
    && parentWaitingEventId
    && parentStartedEventPayload
    && parentWaitingEventPayload
  ) {
    publishRunEvent(workflow.parentRunId, {
      kind: "event",
      id: parentStartedEventId,
      nodeId: workflow.parentNodeId,
      type: "node.subworkflow.started",
      payload: parentStartedEventPayload,
      createdAt: parentCheckpointAt.toISOString(),
    });
    publishRunEvent(workflow.parentRunId, {
      kind: "event",
      id: parentWaitingEventId,
      nodeId: workflow.parentNodeId,
      type: "node.waiting",
      payload: parentWaitingEventPayload,
      createdAt: new Date(parentCheckpointAt.getTime() + 1).toISOString(),
    });
  }

  // Root nodes are the only initial queue entries. Everything else reaches
  // the queue through `WorkflowRuntime.enqueueReadyNodes` after its
  // predecessors complete, preserving fan-in/fan-out semantics.
  const startNodes = workflow.nodes.filter((node) => startNodeIds.has(node.id));

  for (const node of startNodes) {
    await publishInitialNode({
      runId,
      nodeId: node.id,
      attempt: 1,
      publicationGeneration: 1,
    });
  }

  return { runId, ...(parentWaitingMetadata ? { parentWaitingMetadata } : {}) };
}
