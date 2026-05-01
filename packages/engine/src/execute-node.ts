import { nodeRegistry } from "./node-registry";
import { getRunContext, getRunOrgId } from "./persistence";
import { redactValues, renderTemplateWithRedactions } from "./template";
import type { ExecuteNodeInput, NodeExecutionResult } from "./core/types";

export async function executeNode(input: Pick<ExecuteNodeInput, "runId" | "node">): Promise<NodeExecutionResult> {
  const { node, runId } = input;

  const executor = nodeRegistry[node.type];

  if (!executor) {
    throw new Error(`No executor for node type: ${node.type}`);
  }

  // ENG-012: resolve org scope once per node execution so executors can
  // attribute usage telemetry without duplicating the lookup. A missing
  // run row is fatal — silently writing usage rows with a synthetic
  // "default" orgId would pollute multi-tenant cost accounting (see the
  // multi-tenant invariant in AGENTS.md). Same shape as the missing-executor
  // throw above.
  const orgId = await getRunOrgId(runId);
  if (!orgId) {
    throw new Error(`Cannot execute node: run ${runId} not found`);
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
    orgId,
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
