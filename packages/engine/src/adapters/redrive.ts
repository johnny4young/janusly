/**
 * Production redrive — resume a FAILED run from its failed node, on a chosen
 * (typically newer, patched) saved workflow version, without re-executing the
 * work that already succeeded.
 *
 * Creates a linked continuation run: every predecessor of the failed node
 * (computed on the TARGET version's graph) is cloned `succeeded` from the
 * source run's terminal state, the failed node starts `queued`, downstream
 * nodes wait `pending`, and sibling branches are `skipped` — the same node
 * policy as the Replay Lab fork, but WITHOUT `replayMode: "validation"`:
 * write-side effects execute for real. The engine's `enqueueReadyNodes`
 * cascade takes over after the first node completes.
 *
 * Used by `apps/api/src/routes/runs-routes.ts` (`POST /runs/redrive`) after
 * org-scope + role gates.
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; this adapter trusts
 *   its caller resolved the org-scoped source run and target version.
 * - The continuation-run insert is one transaction (runs + runNodes + the
 *   `run.started.redrive` event) — same atomicity contract as `startRun`.
 * - `parentLinkKind: "replay"` — trace-only lineage. Redrive lineage never
 *   participates in subworkflow terminal delivery or depth accounting.
 * - A predecessor that did not succeed in the source run rejects the redrive
 *   (`predecessor_not_succeeded`) — a node the target version ADDED upstream
 *   of the failed node has no source state and rejects the same way. Strict
 *   v1 policy, mirroring the Replay Lab fork.
 */

import { eq } from "drizzle-orm";
import { db, runs, runNodes, runEvents } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { enqueueNode } from "../queue";
import { appendEvent, markQueuePublicationSucceeded } from "../persistence";
import { safePersistPayload } from "../safe-persist";
import { computePredecessors, computeSuccessors } from "./replay-lab";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

/** Input for the production redrive path. */
export type RedriveInput = {
  /** Org scope for the continuation run (already validated by the route). */
  orgId: string;
  /** The failed run being continued. */
  sourceRunId: string;
  /** The failed node to resume from — must exist in the target version. */
  failedNodeId: string;
  /** The TARGET version's executable workflow (typically the patched latest). */
  workflow: Workflow;
  /** The target `workflow_versions.id` — recorded on the new run for attribution. */
  targetWorkflowVersionId: string;
  /** The source run's trigger input, carried forward so `context.input` resolves. */
  input: Record<string, unknown>;
  createdBy?: string | null;
};

export type RedriveResult =
  | { ok: true; runId: string; predecessorCount: number }
  | { ok: false; code: "node_not_in_version" | "predecessor_not_succeeded"; message: string; details?: Record<string, unknown> };

export async function redriveRun(args: RedriveInput): Promise<RedriveResult> {
  const { orgId, sourceRunId, failedNodeId, workflow, targetWorkflowVersionId, input, createdBy } = args;

  if (!workflow.nodes.some((node) => node.id === failedNodeId)) {
    return {
      ok: false,
      code: "node_not_in_version",
      message: `Failed node "${failedNodeId}" is not part of the target workflow version.`,
    };
  }

  // Graph roles computed on the TARGET version — the run resumes on the new
  // shape, reusing source outputs matched by node id.
  const predIds = computePredecessors(workflow, failedNodeId);
  const downstreamIds = computeSuccessors(workflow, failedNodeId);

  const sourceRows = await db
    .select()
    .from(runNodes)
    .where(eq(runNodes.runId, sourceRunId));
  const sourceByNodeId = new Map(sourceRows.map((row) => [row.nodeId, row] as const));

  for (const predId of predIds) {
    const row = sourceByNodeId.get(predId);
    if (!row || row.status !== "succeeded") {
      return {
        ok: false,
        code: "predecessor_not_succeeded",
        message: `Predecessor node "${predId}" did not succeed in the source run (status: ${row?.status ?? "missing"}).`,
        details: { predId, status: row?.status ?? null },
      };
    }
  }

  const runId = crypto.randomUUID();
  const publicationMarkedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId,
      // The REAL target version id — health/usage attribution follows the
      // patched version, unlike the sandbox paths' synthetic ids.
      workflowVersionId: targetWorkflowVersionId,
      status: "running",
      replayMode: null,
      createdBy: createdBy ?? null,
      // Workflow stored RAW (like `startRun`) so the slim queue worker can
      // reload an executable DAG via `loadRunWorkflowRaw`. The source input
      // is carried forward so `context.input` templates keep resolving.
      inputJson: {
        workflow,
        input,
        redrive: { sourceRunId, failedNodeId, targetWorkflowVersionId },
      },
      parentRunId: sourceRunId,
      parentNodeId: failedNodeId,
      parentLinkKind: "replay",
      traceId: null,
    });

    if (workflow.nodes.length > 0) {
      const skippedAt = new Date();
      await tx.insert(runNodes).values(
        workflow.nodes.map((node) => {
          if (predIds.has(node.id)) {
            const sourceRow = sourceByNodeId.get(node.id);
            return {
              id: crypto.randomUUID(),
              runId,
              nodeId: node.id,
              status: "succeeded" as const,
              stateJson: sourceRow?.stateJson ?? safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
              attempts: 0,
              startedAt: sourceRow?.startedAt ?? null,
              finishedAt: sourceRow?.finishedAt ?? null,
              errorJson: null,
            };
          }
          if (node.id === failedNodeId) {
            return {
              id: crypto.randomUUID(),
              runId,
              nodeId: node.id,
              status: "queued" as const,
              stateJson: safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
              attempts: 1,
              queuePublicationRepairAfter: publicationMarkedAt,
              queuePublicationGeneration: 1,
              startedAt: null,
              finishedAt: null,
              errorJson: null,
            };
          }
          if (downstreamIds.has(node.id)) {
            return {
              id: crypto.randomUUID(),
              runId,
              nodeId: node.id,
              status: "pending" as const,
              stateJson: safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
              attempts: 0,
              startedAt: null,
              finishedAt: null,
              errorJson: null,
            };
          }
          // Sibling branches / disconnected nodes — already ran (or never
          // will) in the source run; the continuation must not re-execute
          // unrelated root branches with real side effects.
          return {
            id: crypto.randomUUID(),
            runId,
            nodeId: node.id,
            status: "skipped" as const,
            stateJson: safePersistPayload({
              skipped: { reason: "outside_redrive_path", failedNodeId },
            }, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
            attempts: 0,
            startedAt: null,
            finishedAt: skippedAt,
            errorJson: null,
          };
        }),
      );
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started.redrive",
      payload: safePersistPayload({
        sourceRunId,
        failedNodeId,
        targetWorkflowVersionId,
        predecessorCount: predIds.size,
      }),
    });
  });

  // Queue ONLY the failed node — `enqueueReadyNodes` cascades from there.
  await enqueueNode({
    runId,
    nodeId: failedNodeId,
    attempt: 1,
    publicationGeneration: 1,
  });
  await markQueuePublicationSucceeded(runId, failedNodeId, 1, 1);
  await appendEvent(runId, failedNodeId, "node.queued", {});

  return { ok: true, runId, predecessorCount: predIds.size };
}
