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
 * Used by `apps/api/src/routes/run-routes/redrive.ts` (`POST /runs/redrive`) after
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

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, runs, runNodes, runEvents } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { publishInitialNode } from "../initial-node-publication";
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
  input: unknown;
  createdBy?: string | null;
  /** Correlation id inherited from the failed source run. */
  traceId?: string | null;
};

export type RedriveResult =
  | { ok: true; runId: string; predecessorCount: number; wasCreated: boolean }
  | { ok: false; code: "node_not_in_version" | "predecessor_not_succeeded"; message: string; details?: Record<string, unknown> };

export async function redriveRun(args: RedriveInput): Promise<RedriveResult> {
  const { orgId, sourceRunId, failedNodeId, workflow, targetWorkflowVersionId, input, createdBy, traceId } = args;

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

  const creation = await db.transaction(async (tx) => {
    const insertedRuns = await tx.insert(runs).values({
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
      traceId: traceId ?? crypto.randomUUID(),
    })
      .onConflictDoNothing({
        target: [runs.orgId, runs.parentRunId, runs.parentNodeId, runs.workflowVersionId],
        where: sql`"parent_link_kind" = 'replay' AND "replay_mode" IS NULL AND "input_json" ? 'redrive'`,
      })
      .returning({ id: runs.id });

    if (!insertedRuns[0]) {
      const existing = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(
          eq(runs.orgId, orgId),
          eq(runs.parentRunId, sourceRunId),
          eq(runs.parentNodeId, failedNodeId),
          eq(runs.workflowVersionId, targetWorkflowVersionId),
          eq(runs.parentLinkKind, "replay"),
          isNull(runs.replayMode),
          sql`${runs.inputJson} ? 'redrive'`,
        ))
        .limit(1);
      if (!existing[0]) throw new Error("Existing redrive continuation could not be resolved");
      return { runId: existing[0].id, wasCreated: false };
    }

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

    return { runId, wasCreated: true };
  });

  if (!creation.wasCreated) {
    return { ok: true, runId: creation.runId, predecessorCount: predIds.size, wasCreated: false };
  }

  // Queue ONLY the failed node — `enqueueReadyNodes` cascades from there.
  await publishInitialNode({
    runId,
    nodeId: failedNodeId,
    attempt: 1,
    publicationGeneration: 1,
  });

  return { ok: true, runId, predecessorCount: predIds.size, wasCreated: true };
}
