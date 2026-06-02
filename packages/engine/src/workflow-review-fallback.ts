/**
 * Helpers for the AI workflow-review surface (`POST /ai/review-workflow`).
 * Two pure functions:
 *
 *   1. `buildReviewFallback(workflow)` — when the LLM is unavailable (no
 *      key, quota exhausted, schema-rejection error, etc.) the API route
 *      falls back to the deterministic readiness check from
 *      `workflow-readiness.ts` and reshapes its issues into the review
 *      shape. Operators get useful findings even without AI; the
 *      `mode: "fallback"` chip on the response signals the source.
 *
 *   2. `sanitizeAiReview(review, workflow)` — post-Zod cleanup for the
 *      LLM-emitted findings. Drops findings whose `nodeId` / `edgeId`
 *      doesn't resolve to a real node/edge in the workflow (the model
 *      occasionally hallucinates ids), then re-rolls up the status. Same
 *      pattern as `sanitizeAiWorkflow` for the generation route.
 *
 * Used by `apps/api/src/routes/ai-routes.ts:/ai/review-workflow`. The
 * route's Zod schema (`ReviewFindingsSchema`) lives in the API module since
 * it's tightly coupled to the structured-output prompt; the engine ships
 * only these helpers + the corresponding types so the AI/web layers can
 * import a shared shape.
 */

import type { Workflow, WorkflowEdge } from "@janusly/shared";
import { checkWorkflowReadiness } from "./workflow-readiness";
import { validateWorkflow } from "./workflow-validation";

/** Severity widened from readiness's `warn` | `fail` to also include
 *  `info` for the AI surface (the AI may emit neutral observations). */
export type ReviewSeverity = "info" | "warn" | "fail";

/** Top-level rolled-up status — same enum shape as readiness so the UI
 *  can render both from the same code path. */
export type ReviewStatus = "pass" | "warn" | "fail";

/**
 * One review finding. AI mode populates `rationale` with the model's
 * reasoning; fallback mode fills it with a deterministic placeholder so
 * the field is always present. `nodeId` / `edgeId` are optional —
 * workflow-level findings (e.g. missing outputs) leave both unset.
 */
export type ReviewFinding = {
  code: string;
  severity: ReviewSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  rationale: string;
  suggestion: string;
};

/** Flat issue list + rolled-up status. Same shape across AI and fallback paths. */
export type ReviewFindings = {
  status: ReviewStatus;
  issues: ReviewFinding[];
};

/**
 * Build a deterministic review payload from structural validation plus
 * the readiness check. Every issue maps 1:1 to a review finding; the
 * `rationale` field carries a stable fallback string so the AI mode's
 * contract (a non-empty rationale on every finding) holds in the fallback
 * path too.
 */
export function buildReviewFallback(workflow: Workflow): ReviewFindings {
  const validation = validateWorkflow(workflow);
  const readiness = checkWorkflowReadiness(workflow);
  const issues: ReviewFinding[] = [
    ...validation.issues.map((issue) => ({
      code: issue.code,
      severity: "fail" as const,
      message: issue.message,
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
      rationale: "Local structural validation failed before semantic review could treat this workflow as production-ready.",
      suggestion: "Fix the workflow graph or node configuration issue, then rerun the review.",
    })),
    ...readiness.issues.map((issue) => ({
      code: issue.code,
      // Readiness severities (`warn` | `fail`) are a strict subset of the
      // review enum (`info` | `warn` | `fail`), so the assignment is
      // structurally safe — TypeScript widens.
      severity: issue.severity,
      message: issue.message,
      nodeId: issue.nodeId,
      rationale: "Local rules-only review. AI semantic review unavailable — see suggestion for the deterministic fix.",
      suggestion: issue.suggestion ?? "No automatic suggestion available.",
    })),
  ];
  return {
    status: rollupStatus(issues),
    issues,
  };
}

/**
 * Keep model-written findings, then append deterministic validation and
 * readiness findings that the model omitted. This lets AI add semantic
 * context without becoming the only guard for hard structural defects.
 */
export function mergeReviewFindings(primary: ReviewFindings, fallback: ReviewFindings): ReviewFindings {
  const issues = [...primary.issues];
  const seen = new Set(issues.map(issueKey));
  for (const issue of fallback.issues) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    issues.push(issue);
    seen.add(key);
  }
  return { status: rollupStatus(issues), issues };
}

/**
 * Drop AI-emitted findings whose `nodeId` / `edgeId` doesn't resolve in
 * the workflow (the LLM occasionally hallucinates ids), then re-roll up
 * the status to the worst surviving severity. Workflow-level findings
 * (no `nodeId` / `edgeId`) are kept verbatim — the AI can legitimately
 * flag missing-outputs / ambiguous-prompt issues without targeting a
 * specific node.
 */
export function sanitizeAiReview(review: ReviewFindings, workflow: Workflow): ReviewFindings {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const edgeIds = collectEdgeIds(workflow.edges);
  const valid = review.issues.filter((issue) => {
    if (issue.nodeId && !nodeIds.has(issue.nodeId)) return false;
    if (issue.edgeId && !edgeIds.has(issue.edgeId)) return false;
    return true;
  });
  return { status: rollupStatus(valid), issues: valid };
}

function collectEdgeIds(edges: WorkflowEdge[]): Set<string> {
  // Only collect edges that carry a real `id`. EdgeSchema makes `id`
  // optional; if a workflow has unidentified edges, the model has no way
  // to reference them anyway, and any AI-emitted `edgeId` referencing a
  // synthetic "edge_N" string would otherwise survive sanitization
  // because the index happens to land on a real edge — pointing at a row
  // the operator can't locate in the canvas. Drop those findings instead.
  const ids = new Set<string>();
  for (const edge of edges) {
    if (typeof edge.id === "string" && edge.id.length > 0) {
      ids.add(edge.id);
    }
  }
  return ids;
}

function rollupStatus(issues: ReviewFinding[]): ReviewStatus {
  if (issues.some((issue) => issue.severity === "fail")) return "fail";
  if (issues.some((issue) => issue.severity === "warn")) return "warn";
  return "pass";
}

function issueKey(issue: ReviewFinding): string {
  return `${issue.code}:${issue.nodeId ?? ""}:${issue.edgeId ?? ""}`;
}
