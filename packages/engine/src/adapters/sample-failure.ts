/**
 * Synthetic failure injection — seeds a `failed` run + an `open`
 * dead-letter row for a code-authored fixture so an operator can drive
 * the real recovery loop (DeadLettersPanel → "Suggest fix" →
 * `/ai/patch-workflow`) on demand. Used by the solution-pack
 * "break a node" demo affordance.
 *
 * This mirrors the dev seeder `scripts/seed-recovery-matrix.ts`: it writes
 * the prerequisite `runs` / `run_nodes` / `run_events` / `dead_letters`
 * rows DIRECTLY rather than through the queue's `DeadLetterQueueAdapter`.
 * That bypass is intentional and correct here — there is no real queued
 * job to dead-letter; the failure is a deterministic demo fixture, not a
 * runtime fault. The fixture payloads are code-resident (no untrusted
 * input), but every jsonb write still goes through `safePersistPayload`
 * to honor the persist chokepoint.
 *
 * Used by `apps/api/src/routes/solution-packs-routes.ts`
 * (`POST /solution-packs/:id/inject-failure`) after `requireRole("editor")`.
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; the run + DLQ rows
 *   carry the caller's `orgId`.
 * - `replayMode` is left null (a "production"-shaped failure) so the row
 *   appears in DeadLettersPanel exactly like a real failure would, same
 *   as the recovery-matrix seeder.
 */

import { db, runs, runNodes, runEvents, deadLetters } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { safePersistPayload } from "../safe-persist";

/** Input for a synthetic failure injection. */
export type InjectSampleFailureInput = {
  /** Org scope for the new failed run + DLQ row. */
  orgId: string;
  /** User who triggered the injection; recorded as `createdBy`. */
  createdBy?: string | null;
  /** Workflow snapshot the failing node lives in (persisted to the DLQ row). */
  workflow: Workflow;
  /** Id of the node inside `workflow.nodes` to mark failed. Must exist. */
  failedNodeId: string;
  /** Persisted error envelope shape the recovery dialog reads. */
  errorJson: Record<string, unknown>;
};

/**
 * Seed a failed run + an open dead-letter row for the given fixture.
 * Returns the new run id + dead-letter id so the caller can route the
 * operator into the recovery dialog. Throws if `failedNodeId` is not a
 * node in `workflow` (the caller — a code-resident pack — guarantees it,
 * and the package test pins the invariant).
 */
export async function injectSampleFailure(
  input: InjectSampleFailureInput,
): Promise<{ runId: string; deadLetterId: string }> {
  const { orgId, createdBy, workflow, failedNodeId, errorJson } = input;

  const failingNode = workflow.nodes.find((node) => node.id === failedNodeId);
  if (!failingNode) {
    throw new Error(`injectSampleFailure: node ${failedNodeId} not found in workflow`);
  }

  const runId = crypto.randomUUID();
  const workflowVersionId = runId; // synthetic — no workflow_versions row needed
  const deadLetterId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId,
      workflowVersionId,
      status: "failed",
      createdBy: createdBy ?? null,
      inputJson: safePersistPayload({ workflow, input: {} }),
    });

    await tx.insert(runNodes).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: failedNodeId,
      status: "failed",
      attempts: 1,
      stateJson: safePersistPayload({}),
      errorJson: safePersistPayload(errorJson),
    });

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: failedNodeId,
      type: "node.failed",
      payload: safePersistPayload({ error: errorJson }),
    });

    await tx.insert(deadLetters).values({
      id: deadLetterId,
      orgId,
      runId,
      nodeId: failedNodeId,
      attempt: 3,
      workflowJson: safePersistPayload(workflow, { maxBytes: Number.POSITIVE_INFINITY }),
      nodeJson: safePersistPayload(failingNode, { maxBytes: Number.POSITIVE_INFINITY }),
      errorJson: safePersistPayload(errorJson),
      status: "open",
    });
  });

  return { runId, deadLetterId };
}
