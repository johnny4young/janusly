import { enqueueNode } from "./queue";

export async function startRun(workflow: any) {
  const runId = crypto.randomUUID();

  const startNodes = workflow.nodes.filter((node: any) => {
    return !workflow.edges.some((e: any) => e.to === node.id);
  });

  for (const node of startNodes) {
    await enqueueNode({ runId, node });
  }

  return { runId };
}
