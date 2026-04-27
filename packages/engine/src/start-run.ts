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
