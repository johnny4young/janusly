import { nodeRegistry } from "./node-registry";
import { getRunContext } from "./persistence";
import { renderTemplate } from "./template";
import type { ExecuteNodeInput, NodeExecutionResult } from "./core/types";

export async function executeNode(input: Pick<ExecuteNodeInput, "runId" | "node">): Promise<NodeExecutionResult> {
  const { node, runId } = input;

  const executor = nodeRegistry[node.type];

  if (!executor) {
    throw new Error(`No executor for node type: ${node.type}`);
  }

  const context = await getRunContext(runId);

  const scope = {
    context,
    inputs: node.config
  };

  const resolvedConfig = renderTemplate(node.config, scope);

  const result = await executor({
    runId,
    nodeId: node.id,
    config: resolvedConfig,
    context
  });

  if (result.status === "waiting") {
    return {
      status: "waiting",
      metadata: result.reason
        ? { reason: result.reason, ...(result.metadata ?? {}) }
        : result.metadata,
    };
  }

  return {
    status: "succeeded",
    output: result.output ?? {},
  };
}
