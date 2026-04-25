import { nodeRegistry } from "./node-registry";
import { getRunContext } from "./persistence";
import { renderTemplate } from "./template";

export async function executeNode(input: any) {
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

  return executor({
    runId,
    nodeId: node.id,
    config: resolvedConfig,
    context
  });
}
