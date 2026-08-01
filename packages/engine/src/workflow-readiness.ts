/**
 * Deterministic production-readiness gate. Sister to `validateWorkflow` —
 * `validateWorkflow` checks structural invariants (cycles, edge targets,
 * condition grammar); this checks **production posture**: are external
 * retry-safe calls retried, are failed tool envelopes observable, is HTTP
 * bound, are secrets template-referenced, are outputs declared, is there an
 * approval upstream of write-side actions?
 *
 * Pure — no DB, no I/O. Returns a flat list of issues with stable
 * `code` strings + a `severity` (`warn` | `fail`) and a top-level rolled-up
 * `status` (`pass` | `warn` | `fail`). The rolled-up status follows the
 * worst-severity rule: any `fail` issue → status `fail`; otherwise any
 * `warn` issue → status `warn`; clean → `pass`.
 *
 * Used by:
 *   - `apps/api/src/routes/workflows-routes.ts` — `POST
 *     /workflows/readiness` returns the result.
 *   - `apps/api/src/routes/run-routes/lifecycle.ts` — `POST /start` consults it when
 *     `JANUSLY_PRODUCTION_MODE` is set and rejects fail-level issues with
 *     HTTP 422.
 *   - `apps/web/src/components/WorkflowReadinessBadge.tsx` — fetches the
 *     result and surfaces the rollup in the app header.
 *
 * Adding a new check: pick a stable `code` string (snake_case), pick a
 * severity, push a new `ReadinessIssue` from inside `checkWorkflowReadiness`.
 * The issue codes are part of the web's localised-message lookup —
 * renaming a code breaks the UI without a TypeScript error.
 *
 * Sister surface to a future AI Workflow Review Agent — that's an
 * AI second-pass with semantic findings; this is rules-only and never
 * falls back. Keep them separate so a deterministic operator-facing gate
 * always exists, even when the LLM is unavailable.
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from "@janusly/shared";
import { SENSITIVE_KEY_PATTERN } from "./safe-persist";
import { isToolInvocationWriteSide } from "./tool-execution";

/** Per-issue severity. `fail` blocks production-mode runs; `warn` is informational. */
export type ReadinessSeverity = "warn" | "fail";

/** One readiness finding. `code` is the stable key the web matches on for localisation; entity ids are set when locatable. */
export type ReadinessIssue = {
  code: string;
  severity: ReadinessSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  /** Optional human-readable hint surfaced next to the issue in the badge expansion. */
  suggestion?: string;
};

/** Top-level rolled-up status — worst severity wins. */
export type ReadinessStatus = "pass" | "warn" | "fail";

/** Flat issue list + rolled-up status, mirroring `WorkflowValidationResult`'s shape. */
export type ReadinessResult = {
  status: ReadinessStatus;
  issues: ReadinessIssue[];
};

// HTTP methods that mutate upstream state. A workflow that POSTs/PUTs/PATCHes
// /DELETEs without an `approval` ancestor in the DAG triggers a warn — many
// internal write-side flows legitimately don't need a human gate, but the
// surface lets operators audit which write-side calls might.
const SENSITIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Tool-name allowlist for write-side actions whose use without a human gate
// warrants a warn. Hardcoded today — append more write-side tool names as
// they're registered. Future option: register a `sensitivity` flag on
// `ToolDefinition` so the registry is the single source.
const SENSITIVE_TOOL_NAMES = new Set([
  "email.send",
  "slack.post",
  "github.create_issue",
  "linear.create_issue",
  "db.query.write",
  "db.query.transaction",
]);
const SENSITIVE_TOOL_SUFFIXES = [".write", ".create", ".send", ".delete", ".update"];

// Template-token shapes that legitimately reference a secret without leaking
// the literal value into the workflow JSON. A field whose KEY matches
// `SENSITIVE_KEY_PATTERN` and whose VALUE is one of these is fine; anything
// else gets `raw_secret_in_config`.
const SECRET_TEMPLATE_PATTERN = /\{\{\s*(secret|env)\.[A-Za-z0-9_-]+\s*\}\}/;

/** Run every deterministic readiness check against a parsed workflow. */
export function checkWorkflowReadiness(workflow: Workflow): ReadinessResult {
  const issues: ReadinessIssue[] = [];
  const sensitiveAncestorCache = new Map<string, boolean>();

  for (const node of workflow.nodes) {
    checkHttpBounds(node, issues);
    checkExternalRetry(node, issues);
    checkToolResultPolicy(node, issues);
    checkRawSecretsInConfig(node, issues);
    checkSensitiveAction(node, workflow, sensitiveAncestorCache, issues);
    checkParallelForkPair(node, workflow, issues);
    checkParallelForkJoinSourceCoverage(node, workflow, issues);
    checkJoinSourcesReachable(node, workflow, issues);
  }

  if (!hasDeclaredOutputs(workflow)) {
    issues.push({
      code: "workflow_missing_outputs",
      severity: "warn",
      message: "Workflow declares no `outputs` projection — terminal state will be opaque to downstream consumers.",
      suggestion: "Add an `outputs` map to the workflow root, e.g. { result: '{{context.<lastStep>.output.<field>}}' }.",
    });
  }

  // Eval coverage placeholder — opt-in so a clean workflow can actually
  // reach `status: "pass"`. When env `JANUSLY_REQUIRE_EVAL_COVERAGE=true`
  // (set by orgs that want operators reminded until eval tracking lands),
  // we emit a warn until the eval table exists. Default-off so the badge's
  // green "Production Ready" state is reachable today.
  if (process.env.JANUSLY_REQUIRE_EVAL_COVERAGE === "true") {
    issues.push({
      code: "workflow_missing_evals",
      severity: "warn",
      message: "Eval coverage tracking is not yet enabled. Once eval cases exist, this warn flips off automatically.",
      suggestion: "Add eval cases via the evals harness when available; meanwhile, this warn is informational and not blocking.",
    });
  }

  return {
    status: rollupStatus(issues),
    issues,
  };
}

function rollupStatus(issues: ReadinessIssue[]): ReadinessStatus {
  if (issues.some((issue) => issue.severity === "fail")) return "fail";
  if (issues.some((issue) => issue.severity === "warn")) return "warn";
  return "pass";
}

function checkHttpBounds(node: WorkflowNode, issues: ReadinessIssue[]) {
  if (node.type !== "http") return;
  const config = node.config as Record<string, unknown>;
  const hasAnyBound =
    typeof config.timeoutMs === "number" ||
    typeof config.maxResponseBytes === "number" ||
    typeof config.maxRedirects === "number";
  if (hasAnyBound) return;
  issues.push({
    code: "http_missing_bounds",
    severity: "warn",
    message: `HTTP node "${node.id}" relies on the platform defaults (30s timeout / 1 MB body cap / 5 redirect hops).`,
    nodeId: node.id,
    suggestion: "Set at least one of `timeoutMs`, `maxResponseBytes`, or `maxRedirects` to record the operator's intent. Defaults still apply if unset.",
  });
}

function checkExternalRetry(node: WorkflowNode, issues: ReadinessIssue[]) {
  // Automatic whole-node retries are only a readiness requirement when the
  // call is statically read-side. Write-side HTTP/tools can have committed
  // before failing, so the runtime deliberately suppresses blind retries.
  const retrySafe = node.type === "http"
    ? !isSensitiveAction(node)
    : node.type === "tool" && !isToolInvocationWriteSide(node.config.tool, node.config.input);
  if (!retrySafe) return;
  const retry = (node.config as { retry?: unknown }).retry;
  const maxAttempts = isObject(retry) && typeof (retry as { maxAttempts?: unknown }).maxAttempts === "number"
    ? (retry as { maxAttempts: number }).maxAttempts
    : 1;
  if (maxAttempts >= 2) return;
  issues.push({
    code: "external_node_missing_retry",
    severity: "fail",
    message: `Read-side node "${node.id}" makes an external call but has no retry policy. Transient failures will mark the run failed instead of being retried.`,
    nodeId: node.id,
    suggestion: "Set `config.retry.maxAttempts` to at least 2; production-grade is typically 3–5 with exponential backoff.",
  });
}

function checkToolResultPolicy(node: WorkflowNode, issues: ReadinessIssue[]) {
  if (node.type !== "tool") return;
  if (!isToolInvocationWriteSide(node.config.tool, node.config.input)) return;
  if (node.config.resultPolicy === "require_ok") return;
  issues.push({
    code: "tool_result_policy_missing",
    severity: "fail",
    message: `Write-side tool node "${node.id}" can return a failed result envelope without failing the run.`,
    nodeId: node.id,
    suggestion: "Set `config.resultPolicy` to `require_ok` so failed provider envelopes enter DLQ and recovery without unsafe blind retries.",
  });
}

function checkRawSecretsInConfig(node: WorkflowNode, issues: ReadinessIssue[]) {
  walkConfig(node.config, (key, value) => {
    if (!SENSITIVE_KEY_PATTERN.test(key)) return;
    if (typeof value !== "string") return;
    // Empty / supported template values (`{{secret.X}}`, `{{env.X}}`) are fine.
    if (value.trim() === "") return;
    if (SECRET_TEMPLATE_PATTERN.test(value)) return;
    issues.push({
      code: "raw_secret_in_config",
      severity: "fail",
      message: `Node "${node.id}" hardcodes what looks like a secret in field \`${key}\`. The persistence chokepoint will scrub it at write time, but the saved workflow JSON still carries the literal value.`,
      nodeId: node.id,
      suggestion: `Replace the value with a supported template reference such as \`{{secret.${key.toUpperCase()}}}\` / \`{{env.${key.toUpperCase()}}}\`, or move the call to an integration tool that references an operator-managed credential by name.`,
    });
  });
}

function checkSensitiveAction(
  node: WorkflowNode,
  workflow: Workflow,
  cache: Map<string, boolean>,
  issues: ReadinessIssue[],
) {
  if (!isSensitiveAction(node)) return;
  if (hasApprovalAncestor(node.id, workflow.edges, workflow.nodes, cache)) return;
  issues.push({
    code: "sensitive_action_missing_approval",
    severity: "warn",
    message: `Node "${node.id}" performs a write-side action without a human-approval gate upstream. Verify this is intentional for production.`,
    nodeId: node.id,
    suggestion: "Add an `approval` node upstream so a human can review before the write fires. Or document why this workflow runs unattended.",
  });
}

export function isSensitiveAction(node: WorkflowNode): boolean {
  if (node.type === "http") {
    const method = String((node.config as { method?: unknown }).method ?? "GET").toUpperCase();
    return SENSITIVE_HTTP_METHODS.has(method);
  }
  if (node.type === "tool") {
    const tool = (node.config as { tool?: unknown }).tool;
    if (typeof tool !== "string") return false;
    if (SENSITIVE_TOOL_NAMES.has(tool)) return true;
    return SENSITIVE_TOOL_SUFFIXES.some((suffix) => tool.endsWith(suffix));
  }
  if (node.type === "loop" && node.config.mode === "for_each") {
    return isToolInvocationWriteSide(node.config.tool, node.config.input);
  }
  // External MCP tool invocations are treated as write-side by default.
  // The workflow JSON only carries (connectionAlias, toolName); the
  // per-tool `writeSide` flag lives on the API-side `mcp_tool_descriptors`
  // table and isn't visible at suggestion time. Fail-safe matches the
  // descriptor table's own posture (`writeSide: true` default, admins
  // mark read-only explicitly). False positives just surface an extra
  // approval suggestion in the Recovery dialog that the operator can
  // ignore; false negatives miss a real write that needed a human gate.
  if (node.type === "mcp_tool") return true;
  return false;
}

export function hasApprovalAncestor(
  nodeId: string,
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
  cache: Map<string, boolean>,
): boolean {
  if (cache.has(nodeId)) return cache.get(nodeId)!;
  const visited = new Set<string>();
  const stack = edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const upstream = nodes.find((n) => n.id === id);
    if (upstream?.type === "approval") {
      cache.set(nodeId, true);
      return true;
    }
    for (const edge of edges) {
      if (edge.to === id) stack.push(edge.from);
    }
  }
  cache.set(nodeId, false);
  return false;
}

function checkParallelForkPair(
  node: WorkflowNode,
  workflow: Workflow,
  issues: ReadinessIssue[],
) {
  if (node.type !== "parallel_fork") return;
  if (hasJoinDownstream(node.id, workflow.edges, workflow.nodes)) return;
  issues.push({
    code: "fork_without_join_pair",
    severity: "warn",
    message: `Parallel-fork node "${node.id}" has no \`join\` node downstream. The workflow can run, but branch outputs won't be merged into a single labelled record.`,
    nodeId: node.id,
    suggestion: "Add a `join` node downstream of every branch so the merged outputs are addressable as `{{context.<join>.output.branches.<label>}}`.",
  });
}

function checkJoinSourcesReachable(
  node: WorkflowNode,
  workflow: Workflow,
  issues: ReadinessIssue[],
) {
  if (node.type !== "join") return;
  const sources = (node.config as { sources?: unknown }).sources;
  if (!isObject(sources)) return; // executor-time validation will catch the malformed shape
  const predecessors = collectAncestors(node.id, workflow.edges);
  for (const [label, predecessorId] of Object.entries(sources)) {
    if (typeof predecessorId !== "string" || predecessorId.length === 0) continue;
    if (predecessors.has(predecessorId)) continue;
    issues.push({
      code: "join_sources_unreachable",
      severity: "fail",
      message: `Join node "${node.id}" references predecessor "${predecessorId}" for branch "${label}", but that node is not reachable as an upstream of this join.`,
      nodeId: node.id,
      suggestion: `Add an edge from "${predecessorId}" to "${node.id}" (or update the source to a node that is actually a predecessor).`,
    });
  }
}

function checkParallelForkJoinSourceCoverage(
  node: WorkflowNode,
  workflow: Workflow,
  issues: ReadinessIssue[],
) {
  if (node.type !== "parallel_fork") return;
  const labels = readParallelForkLabels(node.config);
  if (labels.length === 0) return; // executor-time validation catches malformed branches

  const downstreamJoins = collectDownstreamJoinNodes(node.id, workflow.edges, workflow.nodes);
  if (downstreamJoins.length === 0) return; // `fork_without_join_pair` reports this as a warn

  for (const join of downstreamJoins) {
    const sources = (join.config as { sources?: unknown }).sources;
    if (!isObject(sources)) continue;
    const coversEveryLabel = labels.every((label) => typeof sources[label] === "string" && sources[label].trim().length > 0);
    if (coversEveryLabel) return;
  }

  const bestJoin = downstreamJoins
    .map((join) => {
      const sources = (join.config as { sources?: unknown }).sources;
      const sourceLabels = isObject(sources) ? new Set(Object.keys(sources)) : new Set<string>();
      return { join, sourceLabels, coveredCount: labels.filter((label) => sourceLabels.has(label)).length };
    })
    .sort((a, b) => b.coveredCount - a.coveredCount)[0];
  const missing = labels.filter((label) => !bestJoin?.sourceLabels.has(label));
  issues.push({
    code: "fork_join_missing_branch_sources",
    severity: "fail",
    message: `Parallel-fork node "${node.id}" declares branch label${labels.length === 1 ? "" : "s"} ${labels.map((label) => `"${label}"`).join(", ")}, but no downstream join maps every label in \`config.sources\`${bestJoin ? ` (closest join: "${bestJoin.join.id}", missing: ${missing.map((label) => `"${label}"`).join(", ") || "none"})` : ""}.`,
    nodeId: node.id,
    suggestion: "Update the paired `join.config.sources` so it includes every declared fork branch label, e.g. `{ a: '<a_terminal_node>', b: '<b_terminal_node>' }`.",
  });
}

/** True when at least one downstream node from `nodeId` is of type `join`. */
function hasJoinDownstream(
  nodeId: string,
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
): boolean {
  const visited = new Set<string>();
  const stack = edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const downstream = nodes.find((n) => n.id === id);
    if (downstream?.type === "join") return true;
    for (const edge of edges) {
      if (edge.from === id) stack.push(edge.to);
    }
  }
  return false;
}

function collectDownstreamJoinNodes(
  nodeId: string,
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
): WorkflowNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const joins: WorkflowNode[] = [];
  const visited = new Set<string>();
  const stack = edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const downstream = nodeById.get(id);
    if (downstream?.type === "join") joins.push(downstream);
    for (const edge of edges) {
      if (edge.from === id) stack.push(edge.to);
    }
  }
  return joins;
}

/** Collect every transitive ancestor (predecessor) of `nodeId` via the edge graph. */
function collectAncestors(nodeId: string, edges: WorkflowEdge[]): Set<string> {
  const visited = new Set<string>();
  const stack = edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges) {
      if (edge.to === id) stack.push(edge.from);
    }
  }
  return visited;
}

function readParallelForkLabels(config: unknown): string[] {
  if (!isObject(config) || !Array.isArray(config.branches)) return [];
  return config.branches
    .map((branch) => {
      if (!isObject(branch) || typeof branch.label !== "string") return null;
      const label = branch.label.trim();
      return label.length > 0 ? label : null;
    })
    .filter((label): label is string => label !== null);
}

function hasDeclaredOutputs(workflow: Workflow): boolean {
  const outputs = workflow.outputs;
  if (!outputs || typeof outputs !== "object") return false;
  return Object.keys(outputs).length > 0;
}

function walkConfig(value: unknown, visit: (key: string, value: unknown) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkConfig(item, visit));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    walkConfig(item, visit);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
