import { WorkflowSchema, nodeTypeValues } from "@janusly/shared";
import { validateExpression } from "./expression";
import { validateToolInput } from "./tool-registry";

const supportedNodeTypes = new Set<string>(nodeTypeValues);

export type WorkflowValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type WorkflowValidationResult = {
  valid: boolean;
  issues: WorkflowValidationIssue[];
};

export function validateWorkflow(workflow: unknown): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  const parsed = WorkflowSchema.safeParse(workflow);

  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_contract",
        message: `${issue.path.join(".") || "workflow"}: ${issue.message}`,
      })),
    };
  }

  const nodes = parsed.data.nodes;
  const edges = parsed.data.edges;
  const nodeIds = new Set<string>();

  if (nodes.length === 0) {
    issues.push({ code: "empty_workflow", message: "Workflow must include at least one node" });
  }

  for (const node of nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${node.id}`, nodeId: node.id });
    nodeIds.add(node.id);

    if (!supportedNodeTypes.has(node.type)) issues.push({ code: "unsupported_node_type", message: `Unsupported node type: ${node.type}`, nodeId: node.id });
    if (node.type === "http" && !node.config.url) issues.push({ code: "http_missing_url", message: "HTTP node requires config.url", nodeId: node.id });
    if (node.type === "tool" && !node.config.tool) issues.push({ code: "tool_missing_name", message: "Tool node requires config.tool", nodeId: node.id });
    if (node.type === "tool" && typeof node.config.tool === "string") {
      const validation = validateToolInput(node.config.tool, node.config.input ?? {});
      if (!validation.valid) {
        issues.push({ code: "tool_invalid_input", message: validation.issues.join(", "), nodeId: node.id });
      }
    }
    if (node.type === "condition") {
      if (!node.config.expression) {
        issues.push({ code: "condition_missing_expression", message: "Condition node requires config.expression", nodeId: node.id });
      } else {
        const expression = validateExpression(String(node.config.expression));
        if (!expression.valid) issues.push({ code: "condition_invalid_expression", message: expression.message ?? "Invalid condition expression", nodeId: node.id });
      }
    }
    if (node.type === "loop" && !node.config.items) issues.push({ code: "loop_missing_items", message: "Loop node requires config.items", nodeId: node.id });
    if (node.type === "multi_agent" && (!Array.isArray(node.config.agents) || node.config.agents.length === 0)) issues.push({ code: "multi_agent_missing_agents", message: "Multi-agent node requires at least one agent", nodeId: node.id });
  }

  for (const [index, edge] of edges.entries()) {
    const edgeId = edge.id ?? `edge_${index}`;
    if (!nodeIds.has(edge.from)) issues.push({ code: "edge_invalid_from", message: `Edge source does not exist: ${edge.from}`, edgeId });
    if (!nodeIds.has(edge.to)) issues.push({ code: "edge_invalid_to", message: `Edge target does not exist: ${edge.to}`, edgeId });
    if (edge.condition) {
      const expression = validateExpression(edge.condition);
      if (!expression.valid) issues.push({ code: "edge_invalid_condition", message: expression.message ?? "Invalid edge condition", edgeId });
    }
  }

  if (hasCycle(nodes, edges)) issues.push({ code: "cycle_detected", message: "Workflow graph contains a cycle" });

  const incoming = new Set(edges.map((edge) => edge.to));
  const startNodes = nodes.filter((node) => !incoming.has(node.id));
  if (nodes.length > 0 && startNodes.length === 0) issues.push({ code: "missing_start_node", message: "Workflow must have at least one start node" });

  return { valid: issues.length === 0, issues };
}

function hasCycle(nodes: { id: string }[], edges: { from: string; to: string }[]) {
  const graph = new Map<string, string[]>();
  for (const node of nodes) graph.set(node.id, []);
  for (const edge of edges) if (graph.has(edge.from)) graph.get(edge.from)!.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(nodeId: string): boolean {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of graph.get(nodeId) ?? []) if (visit(next)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  }

  return nodes.some(node => visit(node.id));
}
