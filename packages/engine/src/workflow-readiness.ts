/**
 * Deterministic production-readiness gate. Sister to `validateWorkflow` —
 * `validateWorkflow` checks structural invariants (cycles, edge targets,
 * condition grammar); this checks **production posture**: are external
 * calls retried, is HTTP bound, are secrets template-referenced, are
 * outputs declared, is there an approval upstream of write-side actions?
 *
 * Pure — no DB, no I/O. Returns a flat list of issues with stable
 * `code` strings + a `severity` (`warn` | `fail`) and a top-level rolled-up
 * `status` (`pass` | `warn` | `fail`). The rolled-up status follows the
 * worst-severity rule: any `fail` issue → status `fail`; otherwise any
 * `warn` issue → status `warn`; clean → `pass`.
 *
 * Used by:
 *   - `apps/api/src/index.ts` — `POST /workflows/readiness` route returns
 *     the result; `POST /start` consults it when `JANUSLY_PRODUCTION_MODE`
 *     is set and rejects fail-level issues with HTTP 422.
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

/** Per-issue severity. `fail` blocks production-mode runs; `warn` is informational. */
export type ReadinessSeverity = "warn" | "fail";

/** One readiness finding. `code` is the stable key the web matches on for localisation; `nodeId` set when locatable. */
export type ReadinessIssue = {
  code: string;
  severity: ReadinessSeverity;
  message: string;
  nodeId?: string;
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

// External-call node types: each makes a network round-trip that can fail
// transiently. Production workflows must declare a retry policy on these.
const EXTERNAL_CALL_TYPES = new Set<WorkflowNode["type"]>(["http", "tool", "ai", "agent"]);

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
]);
const SENSITIVE_TOOL_SUFFIXES = [".write", ".create", ".send", ".delete", ".update"];

// Template-token shapes that legitimately reference a secret without leaking
// the literal value into the workflow JSON. A field whose KEY matches
// `SENSITIVE_KEY_PATTERN` and whose VALUE is one of these is fine; anything
// else gets `raw_secret_in_config`.
const SECRET_TEMPLATE_PATTERN = /\{\{\s*(secret|env|credential)\.[A-Za-z0-9_-]+\s*\}\}/;

/** Run every deterministic readiness check against a parsed workflow. */
export function checkWorkflowReadiness(workflow: Workflow): ReadinessResult {
  const issues: ReadinessIssue[] = [];
  const sensitiveAncestorCache = new Map<string, boolean>();

  for (const node of workflow.nodes) {
    checkHttpBounds(node, issues);
    checkExternalRetry(node, issues);
    checkRawSecretsInConfig(node, issues);
    checkSensitiveAction(node, workflow, sensitiveAncestorCache, issues);
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
  if (!EXTERNAL_CALL_TYPES.has(node.type)) return;
  const retry = (node.config as { retry?: unknown }).retry;
  const maxAttempts = isObject(retry) && typeof (retry as { maxAttempts?: unknown }).maxAttempts === "number"
    ? (retry as { maxAttempts: number }).maxAttempts
    : 1;
  if (maxAttempts >= 2) return;
  issues.push({
    code: "external_node_missing_retry",
    severity: "fail",
    message: `Node "${node.id}" makes an external call but has no retry policy. Transient failures will mark the run failed instead of being retried.`,
    nodeId: node.id,
    suggestion: "Set `config.retry.maxAttempts` to at least 2; production-grade is typically 3–5 with exponential backoff.",
  });
}

function checkRawSecretsInConfig(node: WorkflowNode, issues: ReadinessIssue[]) {
  walkConfig(node.config, (key, value) => {
    if (!SENSITIVE_KEY_PATTERN.test(key)) return;
    if (typeof value !== "string") return;
    // Empty / template-only / `{{secret.X}}`-shaped values are fine.
    if (value.trim() === "") return;
    if (SECRET_TEMPLATE_PATTERN.test(value)) return;
    issues.push({
      code: "raw_secret_in_config",
      severity: "fail",
      message: `Node "${node.id}" hardcodes what looks like a secret in field \`${key}\`. The persistence chokepoint will scrub it at write time, but the saved workflow JSON still carries the literal value.`,
      nodeId: node.id,
      suggestion: `Replace the value with a template reference such as \`{{secret.${key.toUpperCase()}}}\` or \`{{credential.<NAME>}}\`.`,
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

function isSensitiveAction(node: WorkflowNode): boolean {
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
  return false;
}

function hasApprovalAncestor(
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
