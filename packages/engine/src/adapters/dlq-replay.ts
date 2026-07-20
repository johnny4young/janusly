/**
 * Dead-letter replay adapter — re-enqueues a previously failed node from the
 * `dead_letters` row payload. Resets `attempt` to 1 so the BullMQ retry
 * machinery applies its own policy on the replayed run.
 *
 * Production replay (`replayDeadLetter`) keeps the original `runId` and
 * just re-enqueues the failed node — the recovery dialog calls this AFTER
 * the operator has approved a patch, expecting the existing run to advance
 * past the failure with the new config.
 *
 * Sandbox/validation replay (`replayDeadLetterAsValidation`) creates a
 * fresh run tagged `runs.replayMode = "validation"` and enqueues only the
 * failing node against the suggested workflow. The node executors read
 * the tag through `NodeContext.dryRun` and gate write-side actions
 * (HTTP non-safe methods, tools flagged `writeSide`). The recovery dialog
 * gates the production save+replay on the validation run reaching
 * `succeeded`, so a regression never reaches `workflow_versions`.
 *
 * Used by `apps/api/src/routes/dlq-routes.ts` (`POST /dlq/replay`,
 * `POST /dlq/validate-fix`) after `requireRole` gates editor on the calling
 * user.
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; this adapter trusts
 *   its caller resolved the org-scoped `dead_letters` row.
 * - The validation-run insert is one transaction (runs + runNodes + the
 *   `run.started` event) — same atomicity contract as `startRun`.
 */

import { db, runs, runNodes, runEvents } from "@janusly/db";
import { eq } from "drizzle-orm";
import type { DeadLetterReplayAdapter, DeadLetterReplayInput } from "../core/types";
import type { Workflow, WorkflowNode } from "@janusly/shared";
import { enqueueNode } from "../queue";
import {
  appendEvent,
  claimReplayTransition,
  markQueuePublicationSucceeded,
} from "../persistence";
import { safePersistPayload } from "../safe-persist";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;
const COPYABLE_ANCESTOR_STATUSES = new Set(["succeeded", "skipped"]);

/** Input for the sandbox/validation replay path. */
export type DeadLetterValidationInput = {
  /** Org scope for the new validation run. Must match the DLQ row. */
  orgId: string;
  /** The original failing run id; recorded as `parentRunId` on the new run for traceability. */
  originalRunId: string;
  /** The full suggested workflow snapshot the validation run executes against. */
  suggestedWorkflow: Workflow;
  /** The failing node from the DLQ row, resolved against the suggested workflow's node id. */
  failingNode: WorkflowNode;
  /** User who triggered the validation; recorded as `createdBy`. */
  createdBy?: string | null;
  /** Explicit Recovery Playbook invocation, persisted for outcome attestation. */
  recoveryPlaybookId?: string | null;
};

function collectAncestorNodeIds(workflow: Workflow, nodeId: string): Set<string> {
  const parentsByNode = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const parents = parentsByNode.get(edge.to) ?? [];
    parents.push(edge.from);
    parentsByNode.set(edge.to, parents);
  }

  const ancestors = new Set<string>();
  const stack = [...(parentsByNode.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ancestors.has(current)) continue;
    ancestors.add(current);
    stack.push(...(parentsByNode.get(current) ?? []));
  }
  return ancestors;
}

function collectDescendantNodeIds(workflow: Workflow, nodeId: string): Set<string> {
  const childrenByNode = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const children = childrenByNode.get(edge.from) ?? [];
    children.push(edge.to);
    childrenByNode.set(edge.from, children);
  }

  const descendants = new Set<string>();
  const stack = [...(childrenByNode.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || descendants.has(current)) continue;
    descendants.add(current);
    stack.push(...(childrenByNode.get(current) ?? []));
  }
  return descendants;
}

/** `DeadLetterReplayAdapter` implementation backed by the BullMQ queue. */
export class DLQReplayAdapter implements DeadLetterReplayAdapter {
  /** Re-enqueue the failed node with attempt counter reset to 1. */
  async replayDeadLetter(input: DeadLetterReplayInput): Promise<void> {
    const { runId, workflow, node } = input;

    console.log("[DLQ-REPLAY] Re-enqueue node", {
      runId,
      nodeId: node.id,
    });

    // Atomically un-terminate the run + reset the failed node to `queued`.
    // One transaction closes the previous gap where a cancel landing
    // between the reset and the queue left a queued node on a cancelled run
    // that the runtime guard skips forever (silent false recovery). Claim
    // FIRST — before the snapshot write — so a `node_mid_retry` /
    // `run_not_replayable` rejection mutates nothing: no snapshot is written
    // under an in-flight retry, no job is enqueued. Throws
    // `ReplayNotClaimableError`, mapped to 409 by the `/dlq/replay` route.
    const replayClaim = await claimReplayTransition(
      runId,
      node.id,
      {
        deadLetterId: input.deadLetterId ?? null,
        recoveryActorId: input.recoveryActorId ?? null,
        recoveryPlaybookId: input.recoveryPlaybookId ?? null,
        recoveryValidationRunId: input.recoveryValidationRunId ?? null,
      },
      workflow,
    );

    await enqueueNode({
      runId,
      nodeId: node.id,
      attempt: 1,
      publicationGeneration: replayClaim.publicationGeneration,
      recoveryClaimToken: replayClaim.recoveryClaimToken,
    });
    await markQueuePublicationSucceeded(
      runId,
      node.id,
      1,
      replayClaim.publicationGeneration,
      replayClaim.recoveryClaimToken,
    );
  }

  /**
   * Sandbox replay — create a fresh run tagged `replayMode: "validation"`
   * and enqueue ONLY the failing node against the suggested workflow.
   * Does NOT write to `workflow_versions`. Returns the new run id so the
   * caller can poll until terminal status.
   */
  async replayDeadLetterAsValidation(input: DeadLetterValidationInput): Promise<{ runId: string }> {
    const { orgId, originalRunId, suggestedWorkflow, failingNode, createdBy, recoveryPlaybookId } = input;

    const runId = crypto.randomUUID();
    const ancestorNodeIds = collectAncestorNodeIds(suggestedWorkflow, failingNode.id);
    const descendantNodeIds = collectDescendantNodeIds(suggestedWorkflow, failingNode.id);
    const originalNodeRows = await db.select().from(runNodes).where(eq(runNodes.runId, originalRunId));
    const originalNodeById = new Map(originalNodeRows.map((row) => [row.nodeId, row]));

    // Synthetic version id — mirrors the ad-hoc-run pattern in `startRun`.
    // No row in `workflow_versions` is created; the suggested workflow
    // snapshot lives in `runs.inputJson` and is loaded by the queue at
    // execution time.
    const workflowVersionId = runId;
    const publicationMarkedAt = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(runs).values({
        id: runId,
        orgId,
        workflowVersionId,
        status: "running",
        replayMode: "validation",
        createdBy: createdBy ?? null,
        // Persist the full suggested workflow + failing node id so the
        // queue worker can reload the DAG (`loadRunWorkflowRaw`) without
        // consulting `workflow_versions` (intentionally absent for sandbox
        // runs). The workflow is stored RAW (like `startRun`) — NOT through
        // `safePersistPayload` — because the slim queue reloads it and
        // key-redaction / size-truncation would corrupt an executable DAG.
        inputJson: {
          workflow: suggestedWorkflow,
          failingNodeId: failingNode.id,
          ...(recoveryPlaybookId ? { recoveryPlaybookId } : {}),
        },
        parentRunId: originalRunId,
        parentNodeId: null,
        parentLinkKind: "replay",
        traceId: null,
      });

      // Seed `run_nodes` rows for every node in the suggested workflow
      // so the runtime's status-rollup queries see the same shape they
      // see for production runs. The failing node's queued generation and
      // publication marker commit in this same transaction. Ancestor nodes
      // copy terminal context from the original run so templates on the
      // failing node see the same upstream outputs the production replay
      // would have had.
      if (suggestedWorkflow.nodes.length > 0) {
        await tx.insert(runNodes).values(suggestedWorkflow.nodes.map((node) => {
          const original = originalNodeById.get(node.id);
          const startsQueued = node.id === failingNode.id;
          const canCopyContext = !startsQueued
            && ancestorNodeIds.has(node.id)
            && original
            && COPYABLE_ANCESTOR_STATUSES.has(original.status);
          const continuesValidation = descendantNodeIds.has(node.id);
          const outsideValidationPath = !startsQueued && !canCopyContext && !continuesValidation;

          return {
            id: crypto.randomUUID(),
            runId,
            nodeId: node.id,
            status: canCopyContext
              ? original.status
              : startsQueued
                ? "queued"
                : continuesValidation
                  ? "pending"
                  : "skipped",
            stateJson: safePersistPayload(
              canCopyContext
                ? (original.stateJson ?? {})
                : outsideValidationPath
                  ? { skipped: { reason: "outside_validation_path", failingNodeId: failingNode.id } }
                  : {},
              { maxBytes: INITIAL_NODE_STATE_MAX_BYTES },
            ),
            attempts: canCopyContext ? original.attempts : startsQueued ? 1 : 0,
            queuePublicationRepairAfter: startsQueued ? publicationMarkedAt : null,
            queuePublicationGeneration: startsQueued ? 1 : 0,
            startedAt: canCopyContext ? original.startedAt : null,
            finishedAt: canCopyContext
              ? original.finishedAt
              : outsideValidationPath
                ? publicationMarkedAt
                : null,
            errorJson: canCopyContext ? original.errorJson : null,
          };
        }));
      }

      await tx.insert(runEvents).values({
        id: crypto.randomUUID(),
        runId,
        nodeId: null,
        type: "run.started.validation",
        payload: safePersistPayload({
          workflowVersionId,
          originalRunId,
          failingNodeId: failingNode.id,
          ...(recoveryPlaybookId ? { recoveryPlaybookId } : {}),
        }),
      });
    });

    console.log("[DLQ-VALIDATE] New validation run", {
      runId,
      originalRunId,
      failingNodeId: failingNode.id,
    });

    // Enqueue ONLY the failing node — the runtime's
    // `enqueueReadyNodes` cascade will pick up downstream nodes as the
    // failing node terminates.
    await enqueueNode({
      runId,
      nodeId: failingNode.id,
      attempt: 1,
      publicationGeneration: 1,
    });
    await markQueuePublicationSucceeded(
      runId,
      failingNode.id,
      1,
      1,
    );
    await appendEvent(runId, failingNode.id, "node.queued", {});

    return { runId };
  }
}
