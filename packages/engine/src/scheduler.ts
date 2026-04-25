import { enqueueNode } from "./queue";
import { getNodeStatus } from "./get-node-status";
import { markNodeQueued, markNodeSkipped, getRunContext } from "./persistence";
import { evaluateExpression } from "./expression";

export async function enqueueNextNodes({ runId, workflow }: any) {
  const context = await getRunContext(runId);

  for (const node of workflow.nodes) {
    const incomingEdges = workflow.edges.filter((e: any) => e.to === node.id);

    const deps = incomingEdges.map((e: any) => e.from);

    const depStatuses = await Promise.all(
      deps.map((depId: string) => getNodeStatus(runId, depId))
    );

    const ready = depStatuses.every((s) => ["succeeded", "skipped"].includes(s));

    const currentStatus = await getNodeStatus(runId, node.id);

    if (!ready || currentStatus !== "pending") continue;

    // 🔥 evaluate edge conditions
    let shouldRun = false;

    for (const edge of incomingEdges) {
      if (!edge.condition) {
        shouldRun = true;
        break;
      }

      const result = evaluateExpression(edge.condition, {
        context,
        inputs: {},
      });

      if (result) {
        shouldRun = true;
        break;
      }
    }

    if (!shouldRun) {
      await markNodeSkipped(runId, node.id, { reason: "Condition not met" });
      continue;
    }

    await markNodeQueued(runId, node.id);
    await enqueueNode({ runId, workflow, node });
  }
}
