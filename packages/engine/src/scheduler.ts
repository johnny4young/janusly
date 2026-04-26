import { enqueueNode } from "./queue";
import { getNodeStatus } from "./get-node-status";
import { appendEvent, markNodeQueued, markNodeSkipped, getRunContext, updateRunStatusFromNodes } from "./persistence";
import { evaluateExpression } from "./expression";
import type { Workflow } from "@workflow-engine/shared";

export async function enqueueNextNodes({ runId, workflow }: { runId: string; workflow: Workflow }) {
  const context = await getRunContext(runId);
  let queued = 0;

  for (const node of workflow.nodes) {
    const incomingEdges = workflow.edges.filter((edge) => edge.to === node.id);

    const deps = incomingEdges.map((edge) => edge.from);

    const depStatuses = await Promise.all(
      deps.map((depId: string) => getNodeStatus(runId, depId))
    );

    const ready = depStatuses.every((s) => ["succeeded", "skipped"].includes(s));

    const currentStatus = await getNodeStatus(runId, node.id);

    if (!ready || currentStatus !== "pending") continue;

    // Evaluate edge conditions
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
    await appendEvent(runId, node.id, "node.queued", {});
    queued++;
  }

  if (queued === 0) {
    await updateRunStatusFromNodes(runId);
  }
}
