/**
 * Standalone sandbox run from a workflow snapshot — creates a fresh
 * `runs.replayMode = "validation"` run for an arbitrary workflow + input,
 * with NO source run (`parentRunId = null`). Used by the solution-pack
 * "sample run" surface so an operator can preview a pack's workflow before
 * installing it.
 *
 * Differs from `replayRunAsValidation` (`./replay-lab.ts`): that path forks
 * an existing source run (recorded as `parentRunId`); this one runs a
 * workflow that has no prior run at all. Both share the
 * `runs.replayMode = "validation"` tag, so the same dryRun gating applies —
 * write-side HTTP (POST/PUT/PATCH/DELETE) and `writeSide: true` tools are
 * skipped, and validation runs are excluded from production rollups. A
 * sample run therefore produces a real terminal status (or pauses at an
 * approval / human_form gate) without firing real external calls.
 *
 * Used by `apps/api/src/routes/solution-packs-routes.ts`
 * (`POST /solution-packs/:id/sample-run`) after `requireRole("editor")`.
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; this adapter trusts
 *   its caller resolved the org-scoped workflow snapshot + input.
 * - The insert is one transaction (runs + runNodes + the
 *   `run.started.sandbox` event) — same atomicity contract as `startRun`.
 * - The workflow snapshot lives in `runs.inputJson`; no `workflow_versions`
 *   row is created (sandbox runs never produce reusable versions).
 */

import { db, runs, runNodes, runEvents } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { enqueueNode } from "../queue";
import { appendEvent, markQueuePublicationSucceeded, updateRunStatusFromNodes } from "../persistence";
import { safePersistPayload } from "../safe-persist";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

/** Input for a standalone sandbox run (no source run). */
export type SandboxRunInput = {
  /** Org scope for the new validation run. */
  orgId: string;
  /** Workflow snapshot to execute. Caller owns validation. */
  workflow: Workflow;
  /**
   * Trigger-time input. Persisted to `runs.inputJson.input` so node
   * expressions like `{{input.*}}` / `{{context.<trigger>.output.*}}`
   * resolve to the same values a real run would see.
   */
  input?: unknown;
  /** User who triggered the sample run; recorded as `createdBy`. */
  createdBy?: string | null;
  /**
   * Optional provenance label persisted in the start event's payload so
   * the operator can tell at-a-glance what kicked off the sandbox run
   * (e.g. a solution-pack id). Free-form; never used for authorization.
   */
  source?: string;
};

function rootNodeIds(workflow: Workflow): Set<string> {
  const nodesWithIncomingEdges = new Set(workflow.edges.map((edge) => edge.to));
  return new Set(
    workflow.nodes
      .filter((node) => !nodesWithIncomingEdges.has(node.id))
      .map((node) => node.id),
  );
}

function nodesReadyAfterSeededRoots(workflow: Workflow, rootIds: Set<string>): Workflow["nodes"] {
  const predecessorsByNode = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const predecessors = predecessorsByNode.get(edge.to) ?? [];
    predecessors.push(edge.from);
    predecessorsByNode.set(edge.to, predecessors);
  }

  return workflow.nodes.filter((node) => {
    if (rootIds.has(node.id)) return false;
    const predecessors = predecessorsByNode.get(node.id) ?? [];
    return predecessors.length > 0 && predecessors.every((predecessor) => rootIds.has(predecessor));
  });
}

/**
 * Write a fresh `runs.replayMode="validation"` row, seed root triggers as
 * succeeded, and commit their immediately-ready successors as durably marked
 * `queued`. The runtime's `enqueueReadyNodes`
 * cascade picks up downstream nodes as each terminates. Returns the new
 * run id so the caller can poll / stream until terminal status.
 */
export async function startSandboxRun(args: SandboxRunInput): Promise<{ runId: string }> {
  const { orgId, workflow, input, createdBy, source } = args;

  const runId = crypto.randomUUID();
  // Synthetic version id — mirrors the ad-hoc-run pattern in `startRun` and
  // `replayRunAsValidation`. No `workflow_versions` row is created; the
  // snapshot lives in `runs.inputJson` and is loaded by the worker at
  // execution time.
  const workflowVersionId = runId;
  const now = new Date();
  const seededOutput = (input ?? {}) as Record<string, unknown>;

  // Treat root nodes (no incoming edges) as the trigger that ALREADY fired
  // with the provided sample input: seed them `succeeded` with the input as
  // their `output`, so downstream `{{context.<trigger>.output.*}}` references
  // resolve and the run flows past the trigger. Without this, a `webhook`
  // trigger node would sit in `waiting` forever (it only resumes on an
  // external webhook POST), hanging the sample run. The body of the
  // workflow then runs for real — AI executes, write-side HTTP / tools are
  // dry-run-skipped (validation mode), and approval / human_form gates pause
  // live so the operator sees the human checkpoint.
  const rootIds = rootNodeIds(workflow);
  const readyNodes = nodesReadyAfterSeededRoots(workflow, rootIds);
  const readyNodeIds = new Set(readyNodes.map((node) => node.id));

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId,
      workflowVersionId,
      status: "running",
      replayMode: "validation",
      createdBy: createdBy ?? null,
      // Workflow stored RAW (like `startRun`) so the slim queue worker can
      // reload an executable DAG via `loadRunWorkflowRaw` — key-redaction /
      // size-truncation would corrupt it.
      inputJson: { workflow, input: input ?? {} },
      parentRunId: null,
      parentNodeId: null,
      traceId: null,
    });

    if (workflow.nodes.length > 0) {
      await tx.insert(runNodes).values(
        workflow.nodes.map((node) => {
          const isRoot = rootIds.has(node.id);
          const startsQueued = readyNodeIds.has(node.id);
          return {
            id: crypto.randomUUID(),
            runId,
            nodeId: node.id,
            status: isRoot
              ? ("succeeded" as const)
              : startsQueued
                ? ("queued" as const)
                : ("pending" as const),
            stateJson: safePersistPayload(isRoot ? { output: seededOutput } : {}, {
              maxBytes: INITIAL_NODE_STATE_MAX_BYTES,
            }),
            attempts: startsQueued ? 1 : 0,
            queuePublicationRepairAfter: startsQueued ? now : null,
            queuePublicationGeneration: startsQueued ? 1 : 0,
            startedAt: isRoot ? now : null,
            finishedAt: isRoot ? now : null,
            errorJson: null,
          };
        }),
      );
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started.sandbox",
      payload: safePersistPayload({
        workflowVersionId,
        source: source ?? null,
      }),
    });
  });

  // Timeline: show each root trigger as completed with the seeded payload.
  for (const rootId of rootIds) {
    await appendEvent(runId, rootId, "node.completed", { output: seededOutput, sandboxTrigger: true });
  }

  // Publish every durably queued node whose predecessors are ALL
  // seeded-succeeded (the direct successors of the roots). The runtime's `enqueueReadyNodes`
  // cascade picks up the rest as each node terminates — the same pattern
  // `replayDeadLetterAsValidation` uses after seeding ancestor state.
  for (const node of readyNodes) {
    await enqueueNode({
      runId,
      nodeId: node.id,
      attempt: 1,
      publicationGeneration: 1,
    });
    await markQueuePublicationSucceeded(
      runId,
      node.id,
      1,
      1,
    );
    await appendEvent(runId, node.id, "node.queued", {});
  }

  // Edge case: a workflow with no edges (every node is a root → all seeded
  // `succeeded`) enqueues nothing, so the worker never flips the run out of
  // "running". Finalize the status rollup directly so such a run still
  // reaches its terminal state instead of hanging.
  if (readyNodes.length === 0 && workflow.nodes.length > 0) {
    await updateRunStatusFromNodes(runId);
  }

  return { runId };
}
