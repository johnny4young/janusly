import { db } from "@workflow-engine/db";
import { runs, runNodes } from "@workflow-engine/db";
import { enqueueNode } from "./queue";
import { markNodeQueued, appendEvent } from "./persistence";
import type { Workflow } from "@workflow-engine/shared";

export type StartableWorkflow = Workflow & {
  orgId?: string;
  createdBy?: string | null;
  input?: Record<string, unknown>;
  versionId?: string;
};

export async function startRun(workflow: StartableWorkflow) {
  const runId = crypto.randomUUID();
  const workflowVersionId = workflow.versionId ?? workflow.id ?? runId;

  await db.insert(runs).values({
    id: runId,
    orgId: workflow.orgId ?? "default",
    workflowVersionId,
    status: "running",
    createdBy: workflow.createdBy ?? null,
    inputJson: { workflow, input: workflow.input ?? {} },
  });

  for (const node of workflow.nodes) {
    await db.insert(runNodes).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: node.id,
      status: "pending",
      stateJson: {},
    });
  }

  await appendEvent(runId, null, "run.started", { workflowVersionId });

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
