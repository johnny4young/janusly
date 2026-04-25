import { nodeRegistry } from "./node-registry";

export async function executeNode(input: any) {
  const { node } = input;

  const executor = nodeRegistry[node.type];

  if (!executor) {
    throw new Error(`No executor for node type: ${node.type}`);
  }

  return executor({
    runId: input.runId,
    nodeId: node.id,
    config: node.config,
  });
}
