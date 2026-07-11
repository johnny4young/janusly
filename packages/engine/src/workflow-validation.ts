/**
 * Workflow graph validator. Goes beyond Zod (`WorkflowSchema`) to check
 * cross-node invariants: every edge target/source resolves to a node, the
 * graph has no cycles, every reachable `condition` / edge expression
 * passes the limited grammar in `expression.ts`, and tool nodes' inputs
 * pass the tool's Zod schema.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts` `POST /validate` (the
 * AI Studio surfaces issues to the user) and by `sanitizeAiWorkflow` after
 * AI generation parses a draft.
 *
 * Invariants:
 * - The result is a flat list of issues with stable `code` strings — the
 *   web UI matches on codes to render localised messages. Renaming a code
 *   breaks the UI without a TypeScript error.
 */

import { WorkflowInputSchema, WorkflowSchema, nodeTypeValues } from "@janusly/shared";
import { validateExpression } from "./expression";
import { parseIsoDuration } from "./iso-duration";
import { resolveJoinSources, resolveParallelForkBranches } from "./parallel-fork";
import { resolveScheduleConfig } from "./schedule";
import { resolveTriggerConfig } from "./triggers";
import { isTriggerNodeType } from "@janusly/shared/src/trigger-types";
import { isRegisteredTool, validateToolInput } from "./tool-registry";

const supportedNodeTypes = new Set<string>(nodeTypeValues);

/** One validation finding. `nodeId` / `edgeId` set when the issue is locatable. */
export type WorkflowValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

/** Flat issue list + a top-level `valid` flag. */
export type WorkflowValidationResult = {
  valid: boolean;
  issues: WorkflowValidationIssue[];
};

/**
 * Per-call options for `validateWorkflow`. Default behaviour
 * (`strictToolInputs: true`) keeps every existing call site
 * unchanged — `tool` nodes still must carry every required input
 * declared by the per-tool Zod schema in `tool-registry.ts`.
 *
 * The draft-generation surface (`apps/api/src/ai-runtime.ts`
 * `sanitizeAiWorkflow`) passes `strictToolInputs: false` so the
 * LLM can return a workflow with partial tool inputs the operator
 * finishes in the Inspector. The other validation surfaces
 * (`/start`, `/save`, `/validate`, `/workflows/readiness`, the
 * web pre-save check, the patch matrix, the template load test)
 * keep the default and reject incomplete tool inputs.
 */
export type ValidateWorkflowOptions = {
  /** When `true` (default), every `tool` node's `input` is validated against the per-tool Zod schema. When `false`, the per-tool input check is skipped — `tool_missing_name` still fires. */
  strictToolInputs?: boolean;
};

/** Run every cross-node check; returns `valid: true` only when no issues. */
export function validateWorkflow(workflow: unknown, options: ValidateWorkflowOptions = {}): WorkflowValidationResult {
  const strictToolInputs = options.strictToolInputs ?? true;
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
  const allNodeIds = new Set(nodes.map((node) => node.id));

  if (nodes.length === 0) {
    issues.push({ code: "empty_workflow", message: "Workflow must include at least one node" });
  }

  for (const node of nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate node id: ${node.id}`, nodeId: node.id });
    nodeIds.add(node.id);

    // `context.input` is where `executeNode` merges the run's start/trigger
    // input — a node with the literal id "input" would collide with that
    // slot in the template scope (legacy workflows keep today's behaviour:
    // the merge in `execute-node.ts` is guarded and never clobbers a node).
    if (node.id === "input") {
      issues.push({ code: "node_id_reserved", message: `Node id "input" is reserved for the run input (context.input)`, nodeId: node.id });
    }

    if (!supportedNodeTypes.has(node.type)) issues.push({ code: "unsupported_node_type", message: `Unsupported node type: ${node.type}`, nodeId: node.id });
    if (node.type === "http" && !node.config.url) issues.push({ code: "http_missing_url", message: "HTTP node requires config.url", nodeId: node.id });
    if (node.type === "tool" && !node.config.tool) issues.push({ code: "tool_missing_name", message: "Tool node requires config.tool", nodeId: node.id });
    if (node.type === "tool" && typeof node.config.tool === "string" && !isRegisteredTool(node.config.tool)) {
      issues.push({ code: "tool_invalid_input", message: `Unknown tool: ${node.config.tool}`, nodeId: node.id });
    } else if (strictToolInputs && node.type === "tool" && typeof node.config.tool === "string") {
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
    if ((node.type === "router" || node.type === "router_llm") && Array.isArray(node.config.candidates)) {
      // The runtime routes a decision by SKIPPING every non-chosen candidate
      // that is a direct successor of the router (core/runtime.ts). A
      // candidate without an incoming edge from the router is unroutable:
      // if it is a root it runs at t=0 regardless of the decision, and if
      // it hangs elsewhere the skip can never reach it. Fail at save time.
      const outgoing = new Set(edges.filter((edge) => edge.from === node.id).map((edge) => edge.to));
      for (const entry of node.config.candidates) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        const candidateId =
          typeof e.nodeId === "string" && e.nodeId.trim()
            ? e.nodeId.trim()
            : typeof e.id === "string" && e.id.trim()
              ? e.id.trim()
              : "";
        if (!candidateId) continue;
        if (!allNodeIds.has(candidateId)) {
          issues.push({ code: "router_candidate_unknown", message: `Router candidate does not exist: ${candidateId}`, nodeId: node.id });
        } else if (!outgoing.has(candidateId)) {
          issues.push({
            code: "router_candidate_not_successor",
            message: `Router candidate "${candidateId}" must be a direct successor (add an edge ${node.id} → ${candidateId}) or the decision cannot route`,
            nodeId: node.id,
          });
        }
      }
    }
    if (node.type === "loop" && !node.config.items) issues.push({ code: "loop_missing_items", message: "Loop node requires config.items", nodeId: node.id });
    if (node.type === "wait_until") {
      const duration = typeof node.config.duration === "string" ? node.config.duration : "";
      if (!duration) {
        issues.push({ code: "wait_until_missing_duration", message: "Wait node requires config.duration", nodeId: node.id });
      } else {
        const delayMs = parseIsoDuration(duration);
        if (delayMs === null) {
          issues.push({ code: "wait_until_invalid_duration", message: "Wait node requires a valid ISO 8601 config.duration", nodeId: node.id });
        } else if (delayMs <= 0) {
          issues.push({ code: "wait_until_non_positive_duration", message: "Wait node duration must resolve to a positive number of milliseconds", nodeId: node.id });
        }
      }
    }
    // Future AI generation strategies may produce looser node shapes,
    // and direct operator input can still submit malformed configs, so
    // this validator is the strict runtime gate for required fields on
    // `ai` / `agent` / `transform` nodes. Mirrors the per-type checks
    // above for `http` / `tool` / `condition` / `loop`.
    if (node.type === "ai" && !node.config.prompt) issues.push({ code: "ai_missing_prompt", message: "AI node requires config.prompt", nodeId: node.id });
    if (node.type === "agent" && !node.config.goal) issues.push({ code: "agent_missing_goal", message: "Agent node requires config.goal", nodeId: node.id });
    if (node.type === "transform") {
      const mapping = node.config.mapping;
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping as Record<string, unknown>).length === 0) {
        issues.push({ code: "transform_missing_mapping", message: "Transform node requires a non-empty config.mapping object", nodeId: node.id });
      }
    }
    if (node.type === "multi_agent" && (!Array.isArray(node.config.agents) || node.config.agents.length === 0)) issues.push({ code: "multi_agent_missing_agents", message: "Multi-agent node requires at least one agent", nodeId: node.id });
    if (node.type === "human_form") {
      const schema = WorkflowInputSchema.safeParse(node.config.schema);
      if (!schema.success) {
        issues.push({ code: "human_form_invalid_schema", message: "Human form node requires a valid config.schema", nodeId: node.id });
      } else if (schema.data.type === "object" && (!schema.data.properties || Object.keys(schema.data.properties).length === 0)) {
        issues.push({ code: "human_form_empty_schema", message: "Human form node requires at least one field in config.schema.properties", nodeId: node.id });
      }
    }
    if (node.type === "parallel_fork") {
      try {
        resolveParallelForkBranches(node.config);
      } catch (err) {
        issues.push({
          code: "parallel_fork_invalid_branches",
          message: err instanceof Error ? err.message : "parallel_fork node has invalid config.branches",
          nodeId: node.id,
        });
      }
    }
    if (node.type === "join") {
      try {
        resolveJoinSources(node.config);
      } catch (err) {
        issues.push({
          code: "join_invalid_sources",
          message: err instanceof Error ? err.message : "join node has invalid config.sources",
          nodeId: node.id,
        });
      }
    }
    if (node.type === "schedule") {
      try {
        resolveScheduleConfig(node.config);
      } catch (err) {
        issues.push({
          code: "schedule_invalid_cron",
          message: err instanceof Error ? err.message : "schedule node has invalid config",
          nodeId: node.id,
        });
      }
    }
    // Event-driven trigger nodes — validate the authored config against the
    // shared per-type Zod schema so a malformed alias / bucket / connection
    // surfaces at save time, not at first inbound event.
    if (isTriggerNodeType(node.type)) {
      try {
        resolveTriggerConfig(node.type, node.config);
      } catch (err) {
        issues.push({
          code: "trigger_invalid_config",
          message: err instanceof Error ? err.message : `${node.type} node has invalid config`,
          nodeId: node.id,
        });
      }
    }
    if (node.type === "router" || node.type === "router_llm") {
      // Router nodes feed `config.candidates` into the decision engine, which
      // indexes by `nodeId`. The runtime accepts a legacy `id` field for
      // back-compat (older AI-generated workflows used `id`), but every
      // candidate must carry at least one of the two — otherwise the runtime
      // produces a decision with `chosenNodeId: undefined`, which silently
      // breaks routing without surfacing an error.
      const candidates = node.config.candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        issues.push({ code: "router_missing_candidates", message: `${node.type} node requires a non-empty config.candidates array`, nodeId: node.id });
      } else {
        candidates.forEach((candidate, index) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            issues.push({ code: "router_invalid_candidate", message: `${node.type} candidate at index ${index} must be an object`, nodeId: node.id });
            return;
          }
          const entry = candidate as Record<string, unknown>;
          const hasNodeId = typeof entry.nodeId === "string" && entry.nodeId.trim().length > 0;
          const hasLegacyId = typeof entry.id === "string" && entry.id.trim().length > 0;
          if (!hasNodeId && !hasLegacyId) {
            issues.push({ code: "router_candidate_missing_node_id", message: `${node.type} candidate at index ${index} must have a non-empty nodeId (legacy "id" also accepted)`, nodeId: node.id });
            return;
          }
          const targetNodeId = hasNodeId ? String(entry.nodeId).trim() : String(entry.id).trim();
          if (!allNodeIds.has(targetNodeId)) {
            issues.push({ code: "router_candidate_unknown_node_id", message: `${node.type} candidate at index ${index} references an unknown node: ${targetNodeId}`, nodeId: node.id });
          }
        });
      }
    }
  }

  for (const [index, edge] of edges.entries()) {
    const edgeId = edge.id ?? `edge_${index}`;
    if (!nodeIds.has(edge.from)) issues.push({ code: "edge_invalid_from", message: `Edge source does not exist: ${edge.from}`, edgeId });
    if (!nodeIds.has(edge.to)) issues.push({ code: "edge_invalid_to", message: `Edge target does not exist: ${edge.to}`, edgeId });
    if (edge.condition) {
      const expression = validateExpression(edge.condition);
      if (!expression.valid) issues.push({ code: "edge_invalid_condition", message: expression.message ?? "Invalid edge condition", edgeId });
      // The `inputs.` scope means "this node's config" and only exists while
      // a node executes — edges evaluate with `inputs: {}` (core/runtime),
      // so an `inputs.*` path on an edge is always undefined→falsy and the
      // branch silently never fires. Reject it at
      // save time with a pointer to the run-input path that DOES work.
      // Quoted string literals are stripped first to avoid false positives.
      if (/\binputs(?:\.|\[)/.test(edge.condition.replace(/'[^']*'|"[^"]*"/g, ""))) {
        issues.push({
          code: "edge_condition_inputs_scope",
          message: "Edge conditions cannot reference inputs.* (node config does not exist on an edge) — use context.input.* for the run input or context.<nodeId>.output.* for a step's output",
          edgeId,
        });
      }
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
