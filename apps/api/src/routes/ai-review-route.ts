/**
 * `POST /ai/review-workflow` — AI second-pass production-readiness review.
 *
 * Sister to the deterministic readiness gate at /workflows/readiness — this
 * calls the LLM with a structured-output schema to surface semantic issues
 * rules can't see (ambiguous prompts, PII risk, malformed-but-shape-valid
 * tool inputs), then merges them with the deterministic findings. Upholds
 * the AI-fallback contract: falls back to `buildReviewFallback` (the
 * deterministic readiness check) with `mode: "fallback"` when the LLM is
 * unavailable or throws. Per the AGENTS.md AI-mutation contract this surface
 * audits EVERY path — AI-mode success, the shape-invalid short-circuit, the
 * no-LLM fallback, AND the LLM-error fallback.
 */
import { REVIEW_WORKFLOW_SYSTEM_PROMPT } from "../ai-prompts";
import { buildReviewFallback, mergeReviewFindings, sanitizeAiReview, type ReviewFindings } from "@janusly/engine/src/workflow-review-fallback";
import { WorkflowSchema } from "@janusly/shared";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { orgLlmRuntime, resolveSurfaceModel } from "../ai-runtime";
import { ReviewFindingsSchema } from "../ai-schemas";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { budgetBlockedResponse, gateBudget } from "../budget-gate";
import { localeFromRequest } from "../locale";
import { withBudgetWarning } from "../ai-route-helpers";
import type { Route } from "../routes";

export const aiReviewRoutes: Route[] = [
  { method: "POST", match: "/ai/review-workflow", permission: "ai.write",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "review-workflow", modelOverride);
      const reviewWorkflowIdEarly = typeof candidate.id === "string" ? candidate.id : undefined;
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, workflowId: reviewWorkflowIdEarly, action: "ai.workflow.reviewed" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const parsed = WorkflowSchema.safeParse(candidate);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          code: "invalid_workflow_shape",
          severity: "fail" as const,
          message: `${issue.path.join(".") || "workflow"}: ${issue.message}`,
          rationale: "The workflow JSON failed structural validation before review could run.",
          suggestion: "Fix the schema-level errors and re-submit.",
        }));
        // Audit even shape-invalid fallbacks — every AI mutation surface
        // must record success AND fallback per the AGENTS.md AI-fallback
        // contract. Without this, "shape invalid" requests leave no
        // operator audit trail.
        await auditAction(auth, "ai.workflow.reviewed", { targetType: "ai", metadata: { mode: "fallback", reason: "invalid_workflow_shape" } });
        return sendJson(res, withBudgetWarning({ mode: "fallback", aiError: "Workflow shape invalid", review: { status: "fail", issues } }, budgetGate));
      }

      const workflow = parsed.data;
      if (!llm) {
        await auditAction(auth, "ai.workflow.reviewed", { targetType: "ai", targetId: workflow.id, metadata: { mode: "fallback", reason: "no_llm_configured" } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          review: buildReviewFallback(workflow),
        }, budgetGate));
      }

      try {
        const reviewLocale = localeFromRequest(req);
        const result = await llm.generateObject<ReviewFindings>({
          schema: ReviewFindingsSchema,
          schemaName: "JanuslyWorkflowReview",
          schemaDescription: "Production-readiness review of a Janusly workflow DAG.",
          // Per-issue `code` / `severity` / `nodeId` / `edgeId` stay
          // English (machine contract); only the operator-facing
          // `message` / `rationale` / `suggestion` come back localised.
          system: REVIEW_WORKFLOW_SYSTEM_PROMPT + (reviewLocale === "es"
            ? "\n\nIMPORTANT — RESPONSE LANGUAGE: write the per-issue `message`, `rationale`, and `suggestion` fields in Spanish. Keep `code` (closed enum), `severity` values (`info`/`warn`/`fail`), `nodeId`, and `edgeId` verbatim — they are machine identifiers."
            : ""),
          prompt: JSON.stringify(workflow),
          modelHint: surfaceModel,
          cacheSystemPrompt: true,
          context: { orgId: auth.orgId, userId: auth.userId, workflowId: workflow.id },
        });
        const review = mergeReviewFindings(
          sanitizeAiReview(result.object as ReviewFindings, workflow),
          buildReviewFallback(workflow),
        );
        await auditAction(auth, "ai.workflow.reviewed", { targetType: "ai", targetId: workflow.id, metadata: {
          mode: "ai",
          model: result.model,
          provider: result.provider,
          totalIssues: review.issues.length,
          blockingCount: review.issues.filter((issue) => issue.severity === "fail").length,
        } });
        return sendJson(res, withBudgetWarning({ mode: "ai", model: result.model, provider: result.provider, review }, budgetGate));
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI review failed";
        await auditAction(auth, "ai.workflow.reviewed", { targetType: "ai", targetId: workflow.id, metadata: { mode: "fallback", error: message } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: message,
          review: buildReviewFallback(workflow),
        }, budgetGate));
      }
    } },
];
