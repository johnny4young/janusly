const supportedNodeTypes = new Set([
  "http",
  "condition",
  "tool",
  "agent",
  "multi_agent",
  "agent_reflection",
  "loop",
  "transform",
  "ai",
  "webhook",
  "approval",
  "noop",
]);

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

export function validateWorkflow(workflow: any): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  if (!workflow || typeof workflow !== "object") {
    return { valid: false, issues: [{ code: "invalid_workflow", message: "Workflow must be an object" }] };
  }

  if (!Array.isArray(workflow.nodes)) issues.push({ code: "missing_nodes", message: "Workflow must include a nodes array" });
  if (!Array.isArray(workflow.edges)) issues.push({ code: "missing_edges", message: "Workflow must include an edges array" });

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const nodeIds = new Set<string>();

  for (const node of nodes) {
    if (!node.id) {
      issues.push({ code: "node_missing_id", message: "Node is missing id" });
      continue;
    }

    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${node.id}`, nodeId: node.id });
    nodeIds.add(node.id);

    if (!supportedNodeTypes.has(node.type)) issues.push({ code: "unsupported_node_type", message: `Unsupported node type: ${node.type}`, nodeId: node.id });
    if (node.type === "http" && !node.config?.url) issues.push({ code: "http_missing_url", message: "HTTP node requires config.url", nodeId: node.id });
    if (node.type === "tool" && !node.config?.tool) issues.push({ code: "tool_missing_name", message: "Tool node requires config.tool", nodeId: node.id });
    if (node.type === "condition" && !node.config?.expression) issues.push({ code: "condition_missing_expression", message: "Condition node requires config.expression", nodeId: node.id });
    if (node.type === "loop" && !node.config?.items) issues.push({ code: "loop_missing_items", message: "Loop node requires config.items", nodeId: node.id });
    if (node.type === "multi_agent" && (!Array.isArray(node.config?.agents) || node.config.agents.length === 0)) issues.push({ code: "multi_agent_missing_agents", message: "Multi-agent node requires at least one agent", nodeId: node.id });
  }

  for (const [index, edge] of edges.entries()) {
    const edgeId = edge.id ?? `edge_${index}`;
    if (!edge.from || !edge.to) {
      issues.push({ code: "edge_missing_endpoint", message: "Edge requires from and to", edgeId });
      continue;
    }
    if (!nodeIds.has(edge.from)) issues.push({ code: "edge_invalid_from", message: `Edge source does not exist: ${edge.from}`, edgeId });
    if (!nodeIds.has(edge.to)) issues.push({ code: "edge_invalid_to", message: `Edge target does not exist: ${edge.to}`, edgeId });
  }

  if (hasCycle(nodes, edges)) issues.push({ code: "cycle_detected", message: "Workflow graph contains a cycle" });

  const incoming = new Set(edges.map((e: any) => e.to));
  const startNodes = nodes.filter((n: any) => !incoming.has(n.id));
  if (nodes.length > 0 && startNodes.length === 0) issues.push({ code: "missing_start_node", message: "Workflow must have at least one start node" });

  return { valid: issues.length === 0, issues };
}

function hasCycle(nodes: any[], edges: any[]) {
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
