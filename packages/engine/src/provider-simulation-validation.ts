import type { Workflow } from "@janusly/shared";

import { isProviderSimulationToolInvocation } from "./provider-simulation-policy";

export type ProviderSimulationQualification =
  | { ok: true; effectNodeIds: string[] }
  | { ok: false; reason: string; nodeId?: string };

const DYNAMIC_EFFECT_NODE_TYPES = new Set([
  "agent",
  "multi_agent",
  "loop",
  "mcp_tool",
  "subworkflow",
]);
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function validationPathNodeIds(workflow: Workflow, failingNodeId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const current = children.get(edge.from) ?? [];
    current.push(edge.to);
    children.set(edge.from, current);
  }
  const reachable = new Set<string>();
  const pending = [failingNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(children.get(nodeId) ?? []));
  }
  return reachable;
}

/**
 * Qualifies the exact subgraph a DLQ validation run will execute. Provider
 * simulation deliberately supports only direct, idempotent webhook tool
 * nodes; dynamic planners and nested workflows remain ordinary dry runs.
 */
export function qualifyProviderSimulationWorkflow(
  workflow: Workflow,
  failingNodeId: string,
): ProviderSimulationQualification {
  const path = validationPathNodeIds(workflow, failingNodeId);
  const effectNodeIds: string[] = [];

  for (const node of workflow.nodes) {
    if (!path.has(node.id)) continue;
    if (DYNAMIC_EFFECT_NODE_TYPES.has(node.type)) {
      return {
        ok: false,
        nodeId: node.id,
        reason: `node type ${node.type} cannot produce provider-simulated evidence`,
      };
    }
    if (node.type === "http") {
      const method = typeof node.config.method === "string"
        ? node.config.method.toUpperCase()
        : "GET";
      if (!SAFE_HTTP_METHODS.has(method)) {
        return {
          ok: false,
          nodeId: node.id,
          reason: "write-side HTTP nodes are not supported by provider simulation",
        };
      }
      continue;
    }
    if (node.type !== "tool") continue;

    const tool = typeof node.config.tool === "string" ? node.config.tool : "";
    const toolInput = node.config.input;
    if (!isProviderSimulationToolInvocation(tool, toolInput)) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "tool nodes on the validation path must be idempotent webhook.send calls to a reserved local simulator destination",
      };
    }
    if (node.config.resultPolicy !== "require_ok") {
      return {
        ok: false,
        nodeId: node.id,
        reason: "provider-simulated writes must use resultPolicy=require_ok",
      };
    }
    effectNodeIds.push(node.id);
  }

  if (effectNodeIds.length === 0) {
    return {
      ok: false,
      reason: "the validation path has no provider-simulatable write effect",
    };
  }
  return { ok: true, effectNodeIds };
}
