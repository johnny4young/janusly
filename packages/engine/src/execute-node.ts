import { nodeRegistry } from "./node-registry";
import { getRunContext } from "./persistence";
import { redactValues, renderTemplateWithRedactions } from "./template";
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

  const { rendered: resolvedConfig, redactedValues } = renderTemplateWithRedactions(node.config, scope);

  const result = await executor({
    runId,
    nodeId: node.id,
    config: resolvedConfig,
    context
  });

  if (result.status === "waiting") {
    const metadata = result.reason
      ? { reason: result.reason, ...(result.metadata ?? {}) }
      : result.metadata;
    return {
      status: "waiting",
      metadata: redactValues(metadata, redactedValues),
    };
  }

  // Defense-in-depth: if any output value echoes a resolved secret (e.g. an
  // HTTP node returning the Authorization header it just sent), strip the
  // plaintext value before it is persisted to run_nodes.state_json or
  // run_events.payload. The actual call to the upstream service happened with
  // the resolved value; we just don't keep it in our DB.
  return {
    status: "succeeded",
    output: redactValues(result.output ?? {}, redactedValues),
  };
}
