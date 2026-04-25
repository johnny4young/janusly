import { db } from "@workflow-engine/db";
import { runs, runNodes } from "@workflow-engine/db";
import { enqueueNode } from "./queue";
import { markNodeQueued, appendEvent } from "./persistence";

export async function startRun(workflow: any) {
  const runId = crypto.randomUUID();
  const workflowVersionId = workflow.id;

  await db.insert(runs).values({
    id: runId,
    workflowVersionId,
    status: "running",
    inputJson: workflow.input ?? {},
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

  const startNodes = workflow.nodes.filter((node: any) => {
    return !workflow.edges.some((e: any) => e.to === node.id);
  });

  for (const node of startNodes) {
    await markNodeQueued(runId, node.id);
    await enqueueNode({ runId, workflow, node });
    await appendEvent(runId, node.id, "node.queued", {});
  }

  return { runId };
}
