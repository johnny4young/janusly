/**
 * Standalone sandbox replay — creates a fresh validation run from any
 * source run (not just a DLQ entry) and re-executes the entire DAG from
 * root nodes. Used by the Replay Lab surface.
 *
 * Differs from `replayDeadLetterAsValidation`: the lab path re-executes
 * the whole workflow from scratch (no ancestor-state copy, no single
 * failing-node restart). The semantic is "run this workflow fresh in a
 * sandbox" — operators use it to reproduce a bug or validate a tweak.
 *
 * Both paths share the `runs.replayMode = "validation"` tag so the same
 * dryRun gating, rollup exclusion, and write-side skip behavior applies
 * uniformly. Audit action distinguishes the two intents (`replay_lab.started`
 * vs `recovery.validation_started`).
 *
 * Used by `apps/api/src/routes/runs-routes.ts` (`POST /runs/replay-lab`)
 * after `requireRole("editor")` and rate-limit gates.
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; this adapter trusts
 *   its caller resolved the org-scoped source run + workflow snapshot.
 * - The validation-run insert is one transaction (runs + runNodes + the
 *   `run.started.replay-lab` event) — same atomicity contract as `startRun`.
 * - Workflow snapshot lives in `runs.inputJson`; no `workflow_versions` row
 *   is created (sandbox runs never produce reusable versions).
 */

import { db, runs, runNodes, runEvents } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { enqueueNode } from "../queue";
import { markNodeQueued, appendEvent } from "../persistence";
import { safePersistPayload } from "../safe-persist";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

/** Input for the standalone sandbox-replay path (Replay Lab). */
export type ReplayLabInput = {
  /** Org scope for the new validation run. */
  orgId: string;
  /** The source run id whose workflow snapshot was used as the basis. Recorded as `parentRunId`. */
  sourceRunId: string;
  /**
   * Resolved workflow snapshot to execute. May be the source run's
   * `workflow_versions.dagJson`, the source run's `runs.inputJson.workflow`
   * (ad-hoc fallback), or a caller-supplied patched workflow. Route layer
   * owns the resolution + validation.
   */
  workflow: Workflow;
  /**
   * Trigger-time input the source run was started with. Propagated
   * verbatim to the validation run's `runs.inputJson.input` so node
   * expressions like `{{input.*}}` or `{{trigger.input.*}}` resolve to
   * the same values they saw in the source run. Route layer reads this
   * from `sourceRun.inputJson?.input` (or accepts a caller override when
   * a patch is supplied).
   */
  input?: unknown;
  /** User who triggered the lab replay; recorded as `createdBy`. */
  createdBy?: string | null;
  /**
   * Whether the caller supplied a patched workflow (vs. replaying the
   * source's own snapshot). Persisted in the `run.started.replay-lab`
   * event's payload so the operator can tell at-a-glance which lab runs
   * tested an actual patch.
   */
  hasPatch?: boolean;
};

/**
 * Standalone sandbox replay — write a fresh `runs.replayMode="validation"`
 * row, seed every node as `pending`, then enqueue root nodes. The
 * runtime's `enqueueReadyNodes` cascade picks up downstream nodes as
 * each terminates. Returns the new run id so the caller can poll until
 * terminal status.
 */
export async function replayRunAsValidation(
  args: ReplayLabInput,
): Promise<{ runId: string }> {
  const { orgId, sourceRunId, workflow, input, createdBy, hasPatch } = args;

  const runId = crypto.randomUUID();
  // Synthetic version id — mirrors the ad-hoc-run pattern in `startRun`.
  // No row in `workflow_versions` is created; the workflow snapshot lives
  // in `runs.inputJson` and is loaded by the queue worker at execution time.
  const workflowVersionId = runId;

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId,
      workflowVersionId,
      status: "running",
      replayMode: "validation",
      createdBy: createdBy ?? null,
      // Mirror the `startRun` shape: `inputJson` carries the workflow
      // snapshot AND the trigger input so `{{input.*}}` references
      // resolve to the same values the source run saw.
      inputJson: safePersistPayload({ workflow, input: input ?? {} }),
      parentRunId: sourceRunId,
      parentNodeId: null,
      traceId: null,
    });

    if (workflow.nodes.length > 0) {
      await tx.insert(runNodes).values(
        workflow.nodes.map((node) => ({
          id: crypto.randomUUID(),
          runId,
          nodeId: node.id,
          status: "pending" as const,
          stateJson: safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          errorJson: null,
        })),
      );
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started.replay-lab",
      payload: safePersistPayload({
        workflowVersionId,
        sourceRunId,
        hasPatch: hasPatch === true,
      }),
    });
  });

  // Discover root nodes (no incoming edges) and enqueue them. The
  // runtime's ALL-AND readiness cascade picks up downstream nodes as
  // each predecessor terminates.
  const startNodes = workflow.nodes.filter((node) => {
    return !workflow.edges.some((edge) => edge.to === node.id);
  });

  for (const node of startNodes) {
    await markNodeQueued(runId, node.id);
    await enqueueNode({ runId, workflow, node, attempt: 1 });
    await appendEvent(runId, node.id, "node.queued", {});
  }

  return { runId };
}
