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

import { and, eq } from "drizzle-orm";
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
      // Workflow stored RAW (like `startRun`) so the slim queue worker can
      // reload an executable DAG via `loadRunWorkflowRaw`.
      inputJson: { workflow, input: input ?? {} },
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
    await enqueueNode({ runId, nodeId: node.id, attempt: 1 });
    await appendEvent(runId, node.id, "node.queued", {});
  }

  return { runId };
}

/**
 * Input for a TARGETED sandbox replay — a "fork" starting at a specific node
 * instead of re-running the entire workflow. Predecessors of the fork node
 * are cloned from the source run's terminal state (status='succeeded' with
 * stateJson copied verbatim), so the fork node can read upstream outputs
 * without re-executing them. Saves the cost of upstream HTTP / AI / tool
 * calls that already succeeded in the source run.
 */
export type ReplayLabForkInput = {
  /** Org scope for the new validation run. */
  orgId: string;
  /** The source run id whose terminal state is the basis. */
  sourceRunId: string;
  /** Workflow snapshot whose DAG the fork operates on. */
  workflow: Workflow;
  /** The node id at which to fork. Must exist in workflow.nodes. */
  forkNodeId: string;
  /**
   * Optional override for the fork node's input. When set, the fork node's
   * `stateJson` is seeded with `{ input: inputOverride }` instead of empty
   * — so the operator can re-try the node with a tweaked input without
   * touching the source run.
   */
  inputOverride?: unknown;
  /** Trigger-time input the source run was started with. Same propagation
   *  contract as `replayRunAsValidation` so `{{input.*}}` resolves. */
  input?: unknown;
  /** User who triggered the fork; recorded as `createdBy`. */
  createdBy?: string | null;
};

/** Discriminated result of a fork attempt. Errors do NOT throw — the route
 *  layer reads `ok: false` and maps `code` to an HTTP status. */
export type ReplayLabForkResult =
  | { ok: true; runId: string; predecessorCount: number }
  | { ok: false; code: "fork_node_not_found" | "predecessor_not_succeeded"; message: string; details?: unknown };

/**
 * Compute the transitive predecessors of `forkNodeId` in the workflow's
 * edge graph. Walks backwards (edges where `to === current`) with a
 * visited set so cycles (if any — workflows are DAGs, but be defensive)
 * are bounded. The result does NOT include `forkNodeId` itself.
 *
 * Exported for tests and for the route layer (which can show the predecessor
 * count in the response before kicking off the fork).
 */
export function computePredecessors(workflow: Workflow, forkNodeId: string): Set<string> {
  const preds = new Set<string>();
  const stack: string[] = [forkNodeId];
  const seenStartingPoints = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seenStartingPoints.has(cur)) continue;
    seenStartingPoints.add(cur);
    for (const edge of workflow.edges) {
      if (edge.to === cur && !preds.has(edge.from)) {
        preds.add(edge.from);
        stack.push(edge.from);
      }
    }
  }
  return preds;
}

/**
 * Compute every node reachable downstream from `forkNodeId`. The fork node
 * itself is excluded. Fork runs keep only this downstream closure pending;
 * nodes outside the predecessor/fork/downstream subgraph are marked skipped
 * so the runtime does not accidentally execute unrelated root branches.
 */
export function computeSuccessors(workflow: Workflow, forkNodeId: string): Set<string> {
  const successors = new Set<string>();
  const stack: string[] = [forkNodeId];
  const seenStartingPoints = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seenStartingPoints.has(cur)) continue;
    seenStartingPoints.add(cur);
    for (const edge of workflow.edges) {
      if (edge.from === cur && !successors.has(edge.to)) {
        successors.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  successors.delete(forkNodeId);
  return successors;
}

/**
 * Targeted sandbox replay — clones predecessor state from the source run
 * and starts execution at the requested fork node. The fork run carries
 * `replayMode='validation'` (write-side calls are skipped per the existing
 * dryRun gate), `parentRunId` pointing at the source, and `parentNodeId`
 * pointing at the fork node so audit / comparison surfaces can tell at
 * a glance "this is a fork, not a whole-run replay."
 *
 * Returns a discriminated result rather than throwing so route handlers
 * can map error codes to HTTP statuses without try/catch boilerplate.
 */
export async function replayRunAsValidationFork(
  args: ReplayLabForkInput,
): Promise<ReplayLabForkResult> {
  const { orgId, sourceRunId, workflow, forkNodeId, inputOverride, input, createdBy } = args;

  // 1. Validate forkNodeId exists in the workflow.
  if (!workflow.nodes.some((n) => n.id === forkNodeId)) {
    return {
      ok: false,
      code: "fork_node_not_found",
      message: `Fork node "${forkNodeId}" is not part of the source run's workflow.`,
    };
  }

  // 2. Compute predecessors via BFS backwards through the edges.
  const predIds = computePredecessors(workflow, forkNodeId);
  const downstreamIds = computeSuccessors(workflow, forkNodeId);

  // 3. Read the source run's `run_nodes` rows for every predecessor. We need
  //    their status (must be `succeeded`) and stateJson (to clone forward).
  const sourceNodeIds = [...predIds];
  const sourceRows = sourceNodeIds.length === 0
    ? []
    : await db
        .select()
        .from(runNodes)
        .where(eq(runNodes.runId, sourceRunId));
  const sourceByNodeId = new Map(
    sourceRows
      .filter((r) => sourceNodeIds.includes(r.nodeId))
      .map((r) => [r.nodeId, r] as const),
  );

  // 4. Validate every predecessor terminated `succeeded`. If any failed /
  //    cancelled / pending in the source run, reject — the fork can't use
  //    an unreliable upstream output. v1 strict policy; v1.1 may relax.
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

  // 5. All validation passed. Write the new run + nodes + event in one txn.
  const runId = crypto.randomUUID();
  // Synthetic version id — mirrors the ad-hoc pattern in `startRun` and the
  // sibling whole-run `replayRunAsValidation`. No `workflow_versions` row.
  const workflowVersionId = runId;

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId,
      workflowVersionId,
      status: "running",
      replayMode: "validation",
      createdBy: createdBy ?? null,
      // Workflow stored RAW (like `startRun`) so the slim queue worker can
      // reload an executable DAG via `loadRunWorkflowRaw`.
      inputJson: { workflow, input: input ?? {}, fork: { sourceRunId, forkNodeId, hasOverride: inputOverride !== undefined } },
      parentRunId: sourceRunId,
      parentNodeId: forkNodeId,
      traceId: null,
    });

    if (workflow.nodes.length > 0) {
      const skippedAt = new Date();
      await tx.insert(runNodes).values(
        workflow.nodes.map((node) => {
          if (predIds.has(node.id)) {
            // Predecessor — clone the source run's terminal state so the
            // fork node can read upstream outputs without re-executing.
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
          if (node.id === forkNodeId) {
            // The fork node — seed `stateJson` with the override input
            // (or an empty bag if no override). Status `pending` so the
            // enqueue at the end of this function picks it up.
            const seedState = inputOverride !== undefined
              ? { input: inputOverride }
              : {};
            return {
              id: crypto.randomUUID(),
              runId,
              nodeId: node.id,
              status: "pending" as const,
              stateJson: safePersistPayload(seedState, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
              attempts: 0,
              startedAt: null,
              finishedAt: null,
              errorJson: null,
            };
          }
          if (downstreamIds.has(node.id)) {
            // Downstream of the fork — pending with empty state. The runtime
            // cascade queues these only after the fork path advances.
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
          // Everything else — sibling branches or disconnected nodes that
          // are not part of the fork path. Mark skipped so the fork does
          // not execute unrelated root branches.
          return {
            id: crypto.randomUUID(),
            runId,
            nodeId: node.id,
            status: "skipped" as const,
            stateJson: safePersistPayload({
              skipped: { reason: "outside_replay_fork", forkNodeId },
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
      type: "run.started.replay-lab-fork",
      payload: safePersistPayload({
        workflowVersionId,
        sourceRunId,
        forkNodeId,
        predecessorCount: predIds.size,
        hasOverride: inputOverride !== undefined,
      }),
    });
  });

  // 6. Queue ONLY the fork node. The engine's enqueueReadyNodes cascade
  //    will pick up downstream nodes as the fork node completes (because
  //    its predecessors are already `succeeded` and its own status will
  //    flip to `succeeded` after execution).
  const forkNode = workflow.nodes.find((n) => n.id === forkNodeId);
  if (forkNode) {
    await markNodeQueued(runId, forkNode.id);
    await enqueueNode({ runId, nodeId: forkNode.id, attempt: 1 });
    await appendEvent(runId, forkNode.id, "node.queued", {});
  }

  return { ok: true, runId, predecessorCount: predIds.size };
}
