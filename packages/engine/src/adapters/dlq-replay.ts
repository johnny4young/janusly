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
import { markNodeQueued, appendEvent, resetRunForReplay, setRunWorkflowSnapshot } from "../persistence";
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

/** `DeadLetterReplayAdapter` implementation backed by the BullMQ queue. */
export class DLQReplayAdapter implements DeadLetterReplayAdapter {
  /** Re-enqueue the failed node with attempt counter reset to 1. */
  async replayDeadLetter(input: DeadLetterReplayInput): Promise<void> {
    const { runId, workflow, node } = input;

    console.log("[DLQ-REPLAY] Re-enqueue node", {
      runId,
      nodeId: node.id,
    });

    // Make the replayed workflow authoritative for the run BEFORE enqueueing.
    // Slim jobs carry only `{ runId, nodeId }`; the worker reloads the DAG
    // from `runs.inputJson.workflow`. Writing it here means an auto-healing /
    // recovery replay against a PATCHED workflow has its downstream cascade
    // reload the patched DAG — matching the pre-slim behaviour where the
    // replayed workflow flowed in-memory into `enqueueReadyNodes`. For a
    // normal replay (workflow identical to the snapshot) this is a no-op.
    await setRunWorkflowSnapshot(runId, workflow);

    // Un-terminate the run + reset the failed node so the replay actually
    // re-executes it. Without BOTH, the re-enqueued job is skipped: the
    // runtime's guard drops queued jobs on a `failed`/`cancelled` run, and
    // `markNodeRunning` only claims a `queued` node. `resetRunForReplay` only
    // touches a `failed` run (never un-cancels); `markNodeQueued` mirrors
    // start-run / retry / replay-lab.
    await resetRunForReplay(runId);
    await markNodeQueued(runId, node.id);

    await enqueueNode({
      runId,
      nodeId: node.id,
      attempt: 1,
    });
  }

  /**
   * Sandbox replay — create a fresh run tagged `replayMode: "validation"`
   * and enqueue ONLY the failing node against the suggested workflow.
   * Does NOT write to `workflow_versions`. Returns the new run id so the
   * caller can poll until terminal status.
   */
  async replayDeadLetterAsValidation(input: DeadLetterValidationInput): Promise<{ runId: string }> {
    const { orgId, originalRunId, suggestedWorkflow, failingNode, createdBy } = input;

    const runId = crypto.randomUUID();
    const ancestorNodeIds = collectAncestorNodeIds(suggestedWorkflow, failingNode.id);
    const originalNodeRows = await db.select().from(runNodes).where(eq(runNodes.runId, originalRunId));
    const originalNodeById = new Map(originalNodeRows.map((row) => [row.nodeId, row]));

    // Synthetic version id — mirrors the ad-hoc-run pattern in `startRun`.
    // No row in `workflow_versions` is created; the suggested workflow
    // snapshot lives in `runs.inputJson` and is loaded by the queue at
    // execution time.
    const workflowVersionId = runId;

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
        },
        parentRunId: originalRunId,
        parentNodeId: null,
        traceId: null,
      });

      // Seed `run_nodes` rows for every node in the suggested workflow
      // so the runtime's status-rollup queries see the same shape they
      // see for production runs. `markNodeQueued` will flip the failing
      // node specifically below. Ancestor nodes copy terminal context from
      // the original run so templates on the failing node see the same
      // upstream outputs the production replay would have had.
      if (suggestedWorkflow.nodes.length > 0) {
        await tx.insert(runNodes).values(suggestedWorkflow.nodes.map((node) => {
          const original = originalNodeById.get(node.id);
          const canCopyContext = ancestorNodeIds.has(node.id)
            && original
            && COPYABLE_ANCESTOR_STATUSES.has(original.status);

          return {
            id: crypto.randomUUID(),
            runId,
            nodeId: node.id,
            status: canCopyContext ? original.status : "pending",
            stateJson: safePersistPayload(
              canCopyContext ? (original.stateJson ?? {}) : {},
              { maxBytes: INITIAL_NODE_STATE_MAX_BYTES },
            ),
            attempts: canCopyContext ? original.attempts : 0,
            startedAt: canCopyContext ? original.startedAt : null,
            finishedAt: canCopyContext ? original.finishedAt : null,
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
    await markNodeQueued(runId, failingNode.id);
    await enqueueNode({
      runId,
      nodeId: failingNode.id,
      attempt: 1,
    });
    await appendEvent(runId, failingNode.id, "node.queued", {});

    return { runId };
  }
}
