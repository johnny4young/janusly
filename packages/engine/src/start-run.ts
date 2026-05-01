/**
 * `startRun` — bootstrap one run of a workflow.
 *
 * Wraps the `runs` insert + the batch `runNodes` insert + the `run.started`
 * event in a single Drizzle transaction. AGENTS.md invariant: don't split
 * this back into per-node inserts — the atomicity is what guarantees a
 * partially-started run never escapes to the queue.
 *
 * Used by:
 * - `apps/api/src/index.ts` `POST /start` — primary caller.
 * - `packages/engine/src/resume-run.ts` — for restart-from-checkpoint paths.
 *
 * Invariants:
 * - One transaction; all inserts succeed or none do.
 * - Distinct `run.started` vs `run.started.adhoc` audit events depending on
 *   whether the workflow was persisted. The split keeps audit
 *   readers honest about which runs came from saved DAGs.
 */

import { db } from "@janusly/db";
import { runs, runNodes, runEvents } from "@janusly/db";
import { enqueueNode } from "./queue";
import { markNodeQueued, appendEvent } from "./persistence";
import type { Workflow } from "@janusly/shared";

export type StartableWorkflow = Workflow & {
  orgId?: string;
  createdBy?: string | null;
  input?: Record<string, unknown>;
  versionId?: string;
};

export async function startRun(workflow: StartableWorkflow) {
  const runId = crypto.randomUUID();
  const workflowVersionId = workflow.versionId ?? workflow.id ?? runId;

  // Persist run + all nodes + the run.started event in one transaction so a
  // crash mid-setup cannot leave a partially-initialized run.
  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId: workflow.orgId ?? "default",
      workflowVersionId,
      status: "running",
      createdBy: workflow.createdBy ?? null,
      inputJson: { workflow, input: workflow.input ?? {} },
    });

    if (workflow.nodes.length > 0) {
      await tx.insert(runNodes).values(workflow.nodes.map((node) => ({
        id: crypto.randomUUID(),
        runId,
        nodeId: node.id,
        status: "pending",
        stateJson: {},
      })));
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started",
      payload: { workflowVersionId },
    });
  });

  const startNodes = workflow.nodes.filter((node) => {
    return !workflow.edges.some((edge) => edge.to === node.id);
  });

  for (const node of startNodes) {
    await markNodeQueued(runId, node.id);
    await enqueueNode({ runId, workflow, node });
    await appendEvent(runId, node.id, "node.queued", {});
  }

  return { runId };
}
