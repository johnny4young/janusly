import { enqueueNode } from "./queue";

export async function enqueueNextNodes({ runId, workflow, completedNodeId }: any) {
  for (const node of workflow.nodes) {
    const deps = workflow.edges
      .filter((e: any) => e.to === node.id)
      .map((e: any) => e.from);

    const isReady = deps.every((depId: string) => {
      return workflow.completed?.includes(depId);
    });

    if (isReady && !workflow.queued?.includes(node.id)) {
      workflow.queued = workflow.queued ?? [];
      workflow.queued.push(node.id);

      await enqueueNode({ runId, node });
    }
  }
}
