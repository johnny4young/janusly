/**
 * `POST /ai/suggest-improvement` — authoring assistant that suggests 1-3
 * high-impact improvements to a workflow snapshot (`role: "editor"`).
 *
 * Sister to /ai/patch-workflow but operates without a failing-node id and
 * emits FULL workflow snapshots. Validates each suggestion through the same
 * `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` chain
 * `/ai/generate-workflow` uses, drops invalid suggestions, sorts survivors
 * by confidence desc. Read-only by design — never mutates workflows; the
 * operator applies a chosen suggestion through /workflows/save. Upholds the
 * AI-fallback contract (`{ mode: "fallback", aiError, ... }` when the LLM
 * fails or none survive) and, per the AGENTS.md AI-mutation contract, audits
 * BOTH the AI-mode and fallback paths (including the shape-invalid
 * short-circuit).
 */
import { suggestWorkflowImprovement, type SuggestImprovementResult } from "@janusly/ai";
import { summarizePastFeedback } from "@janusly/data";
import { WorkflowSchema, type EvidenceRow, type Workflow } from "@janusly/shared";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { assembleSuggestImprovementEvidence } from "../ai-evidence";
import { orgLlmRuntime, resolveSurfaceModel, sanitizeAiWorkflow } from "../ai-runtime";
import { AiSuggestImprovementEnvelope } from "../ai-schemas";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { budgetBlockedResponse, gateBudget } from "../budget-gate";
import { localeFromRequest } from "../locale";
import { withBudgetWarning } from "../ai-route-helpers";
import type { Route } from "../routes";

export const aiImproveRoutes: Route[] = [
  { method: "POST", match: "/ai/suggest-improvement", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const focus = typeof body.focus === "string" ? body.focus : undefined;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "suggest-improvement", modelOverride);
      const suggestWorkflowIdEarly = typeof candidate.id === "string" ? candidate.id : undefined;
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, workflowId: suggestWorkflowIdEarly, action: "ai.workflow.improvement_suggested" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      const parsed = WorkflowSchema.safeParse(candidate);
      if (!parsed.success) {
        await auditAction(auth, "ai.workflow.improvement_suggested", { targetType: "ai", metadata: {
          mode: "fallback",
          reason: "invalid_workflow_shape",
        } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: "Workflow shape invalid",
          suggestions: [],
          rationale: `Workflow failed structural validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        }, budgetGate));
      }

      const workflow = parsed.data;
      // Display identity and layout are operator-authored metadata, not part of
      // an LLM's semantic improvement remit. Keep them out of the prompt and
      // restore the original metadata after validating each full replacement.
      const workflowForImprovement: Workflow = {
        ...workflow,
        nodes: workflow.nodes.map(({ label: _label, ...node }) => node),
        ui: undefined,
      };
      const helperResult: SuggestImprovementResult = await suggestWorkflowImprovement({
        llm,
        envelopeSchema: AiSuggestImprovementEnvelope,
        workflow: workflowForImprovement,
        focus,
        model: surfaceModel,
        cacheSystemPrompt: true,
        context: { orgId: auth.orgId, userId: auth.userId, workflowId: workflow.id },
        // See `/ai/patch-workflow` for the locale propagation rationale.
        locale: localeFromRequest(req),
      });

      // Fan-out validation: each suggestion's `patchedWorkflowJson` must
      // pass the engine's strict schema and the AI sanitisation chain.
      // Suggestions that fail validation are dropped without breaking
      // the rest of the batch. Survivors are sorted by confidence desc
      // so the dialog's default chip is the model's most-confident pick.
      type ValidatedSuggestion = {
        workflow: Workflow;
        rationale: string;
        approachLabel: string;
        confidence: number;
      };
      let response: {
        mode: "ai" | "fallback";
        suggestedWorkflow: Workflow | unknown;
        rationale: string;
        suggestions: ValidatedSuggestion[];
        /** "Why this suggestion?" evidence — past-feedback + runbook context
         *  for this workflow. Often empty on a fresh authoring surface. */
        evidence: EvidenceRow[];
        model?: string;
        provider?: string;
        aiError?: string;
      };

      if (helperResult.mode === "ai") {
        const validated: ValidatedSuggestion[] = [];
        for (const item of helperResult.suggestions) {
          try {
            // The LLM emits the workflow as a JSON-stringified blob to
            // keep the structured-output schema small enough for
            // Anthropic's compiled-grammar cap; parse + validate +
            // sanitise here. JSON.parse, WorkflowSchema.safeParse, and
            // sanitizeAiWorkflow are all in the try/catch — any failure
            // drops THIS suggestion without breaking the loop.
            const parsedWorkflow = JSON.parse(item.patchedWorkflowJson);
            const reparsed = WorkflowSchema.safeParse(parsedWorkflow);
            if (!reparsed.success) continue;
            const sanitized = preserveAuthoringMetadata(workflow, sanitizeAiWorkflow(reparsed.data));
            validated.push({
              workflow: sanitized,
              rationale: item.rationale,
              approachLabel: item.approachLabel,
              confidence: item.confidence,
            });
          } catch {
            // Drop this suggestion; keep going. If none survive, the
            // empty-list branch below degrades to fallback.
          }
        }
        validated.sort((a, b) => b.confidence - a.confidence);

        if (validated.length > 0) {
          const top = validated[0]!;
          response = {
            mode: "ai",
            // Back-compat: legacy callers reading these top-level
            // fields see the highest-confidence suggestion. The new UI
            // reads the `suggestions` array directly.
            suggestedWorkflow: top.workflow,
            rationale: top.rationale,
            suggestions: validated,
            evidence: [],
            model: helperResult.model,
            provider: helperResult.provider,
          };
        } else {
          response = {
            mode: "fallback",
            suggestedWorkflow: workflow,
            rationale: "AI returned suggestions that could not be applied safely. The original workflow is unchanged.",
            suggestions: [{
              workflow,
              rationale: "AI returned suggestions that could not be applied safely. The original workflow is unchanged.",
              approachLabel: "other",
              confidence: 0,
            }],
            evidence: [],
            model: helperResult.model,
            provider: helperResult.provider,
            aiError: helperResult.aiError ?? "no_valid_suggestions",
          };
        }
      } else {
        const fallbackItem = helperResult.suggestions[0]!;
        response = {
          mode: "fallback",
          suggestedWorkflow: workflow,
          rationale: fallbackItem.rationale,
          suggestions: [{
            workflow,
            rationale: fallbackItem.rationale,
            approachLabel: fallbackItem.approachLabel,
            confidence: fallbackItem.confidence,
          }],
          evidence: [],
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      // Evidence side-channel — for the authoring surface the only context-
      // derived evidence is this workflow's past-feedback history + its
      // runbook (no failing node → no signature rule / tool contract). Often
      // `[]`. Best-effort: the assembler swallows its own read failures.
      response.evidence = await assembleSuggestImprovementEvidence({
        orgId: auth.orgId,
        workflowId: workflow.id ?? null,
        feedbackSummaries: workflow.id ? await summarizePastFeedback(auth.orgId, workflow.id) : [],
      });

      await auditAction(auth, "ai.workflow.improvement_suggested", { targetType: "ai", targetId: workflow.id, metadata: {
        mode: response.mode,
        model: response.model,
        provider: response.provider,
        aiError: response.aiError,
        suggestionsCount: response.suggestions.length,
        topApproachLabel: response.suggestions[0]?.approachLabel,
        focusProvided: typeof focus === "string" && focus.trim().length > 0,
        evidenceCount: response.evidence.length,
      } });

      return sendJson(res, withBudgetWarning(response, budgetGate));
    } },
];

/** Keep operator-authored labels/layout stable across full-workflow AI replacements. */
function preserveAuthoringMetadata(original: Workflow, suggestion: Workflow): Workflow {
  const originalNodes = new Map(original.nodes.map(node => [node.id, node]))
  const nodes = suggestion.nodes.map(({ label: _suggestedLabel, ...node }) => {
    const label = originalNodes.get(node.id)?.label
    return label ? { ...node, label } : node
  })
  const positions = Object.fromEntries(nodes.flatMap(node => {
    const position = original.ui?.positions?.[node.id]
    return position ? [[node.id, position] as const] : []
  }))
  return {
    ...suggestion,
    nodes,
    ...(Object.keys(positions).length > 0 ? { ui: { positions } } : { ui: undefined }),
  }
}
