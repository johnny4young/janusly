import { enqueueNode } from "./queue";
import { getNodeStatus } from "./get-node-status";
import { markNodeQueued } from "./persistence";

export async function enqueueNextNodes({ runId, workflow }: any) {
  for (const node of workflow.nodes) {
    const deps = workflow.edges
      .filter((e: any) => e.to === node.id)
      .map((e: any) => e.from);

    const depStatuses = await Promise.all(
      deps.map((depId: string) => getNodeStatus(runId, depId))
    );

    const ready = depStatuses.every((s) => ["succeeded", "skipped"].includes(s));

    const currentStatus = await getNodeStatus(runId, node.id);

    if (ready && currentStatus === "pending") {
      await markNodeQueued(runId, node.id);
      await enqueueNode({ runId, workflow, node });
    }
  }
}
