/**
 * `POST /ai/generate-workflow` — draft a brand-new workflow DAG from a
 * natural-language prompt.
 *
 * Upholds the AI-fallback contract: the whole generation pipeline (free-JSON
 * or constrained mode, Best-of-N, Pass-2 noop promotion, self-repair) is
 * wrapped in try/catch and degrades to `{ mode: "fallback", aiError, ... }`
 * with a deterministic fallback workflow on any failure. Per the AGENTS.md
 * AI-mutation contract this surface audits BOTH the AI-mode success AND the
 * fallback path (including the "no provider configured" case — audited
 * without `aiError` on the body so `pnpm evals` stays green with no key).
 */
import { z } from "zod";

import { promoteNoopPlaceholders } from "@janusly/ai";
import { listExposedMcpToolsForAi } from "@janusly/data";
import { type Workflow } from "@janusly/shared";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { budgetAwareCandidateCount, generateWorkflowCandidates, selectBestCandidate } from "../ai-generate-bestofn";
import { composeGenerationExemplars, recordGenerationExemplar, type GenerationExemplarsResult } from "../ai-generation-memory";
import { generateWorkflowFreeJson } from "../ai-generate-freejson";
import { MAX_REPAIR_ATTEMPTS, repairGeneratedWorkflow } from "../ai-repair-workflow";
import { composeGenerationSystemPrompt, GENERATE_WORKFLOW_SYSTEM_PROMPT } from "../ai-prompts";
import { fallbackWorkflowForPrompt, orgLlmRuntime, resolveSurfaceModel, sanitizeAiWorkflow } from "../ai-runtime";
import { AiGenerationWorkflowSchema } from "../ai-schemas";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { budgetBlockedResponse, gateBudget } from "../budget-gate";
import { withBudgetWarning } from "../ai-route-helpers";
import type { Route } from "../routes";

export const aiGenerateRoutes: Route[] = [
  { method: "POST", match: "/ai/generate-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const promptText = typeof body.prompt === "string" ? body.prompt : "";
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "generate-workflow", modelOverride);
      if (promptText.length > orgConfig.ai.promptMaxChars) {
        return sendError(res, "ai_prompt_too_long", `prompt exceeds {{maxChars}} characters`, 413, { maxChars: orgConfig.ai.promptMaxChars });
      }
      // No workflowId yet — /ai/generate-workflow drafts a brand new flow.
      // Only the org-level budget gate applies on this path.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.workflow.generated" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const fallbackWorkflow = fallbackWorkflowForPrompt(promptText);
      if (!llm) {
        // No provider configured. Audit the fallback for observability, but
        // do NOT put `aiError` on the RESPONSE body: `pnpm evals`
        // (`scripts/run-evals.mjs`) skips `requiresMode:"ai"` cases only when
        // the body is `mode:"fallback"` WITHOUT `aiError`, so a dev with no
        // `ANTHROPIC_API_KEY` still gets a green eval run. `aiError` is
        // reserved for an LLM call that was attempted and degraded.
        await auditAction(auth, "ai.workflow.generated", {
          targetType: "ai",
          targetId: fallbackWorkflow?.id,
          metadata: { mode: "fallback", error: "AI provider not configured", generationMode: orgConfig.ai.generationMode },
        });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          ...(fallbackWorkflow ?? {}),
        }, budgetGate));
      }
      // Hoisted above the outer try so the fallback catch can report
      // repair attempts too (0 when generation failed before sanitize).
      let repairAttempts = 0;
      // Best-of-N telemetry: how many candidates were sampled and how many
      // passed the strict validity gate (null = single-shot / not applicable).
      let candidateCount = 1;
      let validCandidates: number | null = null;
      let bonBackoff: { from: number; to: number } | null = null;
      // Few-shot exemplars recalled from memory (empty when memory is off).
      // Hoisted so BOTH the success and fallback audits can log the count/ids.
      let exemplars: GenerationExemplarsResult = { block: "", ids: [], count: 0 };
      try {
        // Generation runs in one of two modes per `ai.generationMode`
        // (default `free_json`): free-JSON parses the model's JSON text
        // server-side; constrained uses the provider's structured-output
        // path. Both validate against `AiGenerationWorkflowSchema`, and any
        // failure flows through the existing try/catch into the fallback
        // contract below.
        // Org-level admins can opt MCP connections into LLM exposure via
        // the `exposeToAi` flag. When present, the connection's enabled
        // tool descriptors (with sanitised descriptions) are appended to
        // the system prompt as DATA so the LLM can reference them when
        // emitting `noop` placeholders that Pass 2 may auto-promote. The
        // composer is a no-op when nothing is exposed → identical
        // behaviour to today for non-opt-in orgs.
        const exposedMcpTools = await listExposedMcpToolsForAi(auth.orgId);
        // Few-shot: recall similar prior workflow shapes (consent-gated; empty
        // when memory is off) and frame them as DATA in the system prompt so
        // they steer every generation mode + Best-of-N candidate.
        exemplars = await composeGenerationExemplars(auth.orgId, promptText);
        const systemPrompt = composeGenerationSystemPrompt(GENERATE_WORKFLOW_SYSTEM_PROMPT, exposedMcpTools, exemplars.block);
        const generationMode = orgConfig.ai.generationMode;
        let pass1Workflow: Workflow;
        let genModel: string;
        let genProvider: string;
        let generationAttempts = 1;
        if (generationMode === "free_json") {
          // Free-JSON mode (default): the model emits the workflow as
          // JSON text validated server-side against the SAME
          // `AiGenerationWorkflowSchema` shapes.
          const ctx = { orgId: auth.orgId, userId: auth.userId };
          // Cost-aware Best-of-N: the configured candidate count collapses to
          // single-shot once monthly spend crosses the budget's warning
          // threshold (the gate above already loaded the envelope — no extra
          // read). No budget configured → configured N applies untouched.
          const candidateTarget = budgetAwareCandidateCount(
            orgConfig.ai.generationCandidates,
            budgetGate.envelope,
          );
          if (candidateTarget < orgConfig.ai.generationCandidates) {
            bonBackoff = { from: orgConfig.ai.generationCandidates, to: candidateTarget };
            await auditAction(auth, "ai.generation.candidates_backoff", {
              targetType: "ai",
              metadata: {
                ...bonBackoff,
                reason: "budget_warning_threshold",
              },
            });
          }
          if (candidateTarget > 1) {
            // Best-of-N: sample N independent drafts and keep the best by a
            // deterministic readiness score. The winner flows through the same
            // promote → sanitize → repair tail as a single-shot draft.
            const candidates = await generateWorkflowCandidates(llm, systemPrompt, promptText, surfaceModel, ctx, candidateTarget, true);
            candidateCount = candidateTarget;
            const selection = selectBestCandidate(candidates);
            if (selection) {
              pass1Workflow = selection.winner.workflow;
              genModel = selection.winner.model;
              genProvider = selection.winner.provider;
              validCandidates = selection.validCount;
              generationAttempts = 1;
            } else {
              // Zero candidates even parsed — fall to the single-shot retry
              // path, which throws into the fallback contract if it also fails.
              validCandidates = 0;
              const gen = await generateWorkflowFreeJson(llm, systemPrompt, promptText, surfaceModel, ctx, true);
              pass1Workflow = gen.workflow;
              genModel = gen.model;
              genProvider = gen.provider;
              generationAttempts = gen.attempts;
            }
          } else {
            // Single-shot (default): retry-on-parse-fail; throws after the
            // attempt cap into the fallback contract below.
            const gen = await generateWorkflowFreeJson(llm, systemPrompt, promptText, surfaceModel, ctx, true);
            pass1Workflow = gen.workflow;
            genModel = gen.model;
            genProvider = gen.provider;
            generationAttempts = gen.attempts;
          }
        } else {
          // Legacy constrained mode: the provider's structured-output path
          // enforces the slim `AiGenerationWorkflowSchema` directly.
          // Non-conformant output throws inside the SDK → fallback below.
          const result = await llm.generateObject<z.infer<typeof AiGenerationWorkflowSchema>>({
            schema: AiGenerationWorkflowSchema,
            schemaName: "JanuslyWorkflow",
            schemaDescription: "Workflow DAG for /ai/generate-workflow.",
            system: systemPrompt,
            prompt: promptText,
            modelHint: surfaceModel,
            cacheSystemPrompt: true,
            context: { orgId: auth.orgId, userId: auth.userId },
          });
          // Cast: the AI-side discriminated-union node configs are strict
          // subsets of the engine's loose `config: Record<string, unknown>`,
          // so the inferred AI shape structurally satisfies `Workflow`. The
          // post-validation `sanitizeAiWorkflow` re-parses through
          // `WorkflowSchema` so a bad cast can never reach persistence.
          pass1Workflow = result.object as unknown as Workflow;
          genModel = result.model;
          genProvider = result.provider;
        }

        // Pass 2: promote any noop placeholder whose id matches a
        // recognised wait-intent prefix into a typed operator-only node.
        // Per-noop failures degrade
        // silently inside the promoter so the workflow is always
        // returned intact. A catastrophic throw here would cascade to
        // the existing fallback envelope below.
        const promotion = await promoteNoopPlaceholders({
          llm,
          workflow: pass1Workflow,
          originalPrompt: promptText,
          context: { orgId: auth.orgId, userId: auth.userId },
          modelHint: surfaceModel,
          // Reuse the exposed-tool list already fetched for the system
          // prompt so the deterministic `mcp_tool` family can resolve any
          // `mcp_<alias>_<tool>` noop into a typed node (empty list when
          // no connection opted into exposeToAi → no mcp promotion).
          availableMcpTools: exposedMcpTools,
        });

        // A draft can parse + shape-validate yet still fail the engine's
        // strict graph validation (e.g. an edge referencing a missing node).
        // Rather than discard it straight to fallback, feed the specific
        // validator issues back to the model for a bounded number of
        // targeted repair attempts. On exhaustion the repair helper rethrows
        // so the outer catch degrades to fallback as before.
        let workflow: Workflow;
        try {
          workflow = sanitizeAiWorkflow(promotion.workflow);
        } catch {
          // Mark the full attempt budget spent up front so an exhausted
          // repair (helper rethrows -> outer catch) reports it on the
          // fallback audit row; a success below reassigns the real count.
          repairAttempts = MAX_REPAIR_ATTEMPTS;
          const repaired = await repairGeneratedWorkflow({
            llm,
            system: systemPrompt,
            originalPrompt: promptText,
            candidate: promotion.workflow,
            modelHint: surfaceModel,
            cacheSystemPrompt: true,
            context: { orgId: auth.orgId, userId: auth.userId },
          });
          workflow = repaired.workflow;
          repairAttempts = repaired.repairAttempts;
          genModel = repaired.model;
          genProvider = repaired.provider;
        }
        // Few-shot WRITE side: persist this prompt → workflow-shape exemplar
        // for future similar prompts. Fire-and-forget + consent-gated inside
        // the helper, so it never delays or breaks the response.
        void recordGenerationExemplar({ orgId: auth.orgId, workflowId: workflow.id, prompt: promptText, workflow });
        await auditAction(auth, "ai.workflow.generated", { targetType: "ai", targetId: workflow.id, metadata: {
          mode: "ai",
          model: genModel,
          provider: genProvider,
          // Generation mechanism + how many free-JSON attempts it took
          // (1 unless retry-on-parse-fail fired). `constrained` always 1.
          generationMode,
          generationAttempts,
          // Best-of-N: candidates sampled (1 = single-shot) and how many passed
          // the strict validity gate (null = single-shot / not applicable).
          candidateCount,
          validCandidates,
          bonBackoff,
          // Few-shot exemplars recalled from memory and framed into the prompt
          // (0 / [] when memory is off). Ids only — never raw exemplar content.
          exemplarCount: exemplars.count,
          exemplarIds: exemplars.ids,
          // Directed self-repair attempts spent when the draft failed strict
          // graph validation (0 when the first draft validated cleanly).
          repairAttempts,
          promotionAttempts: promotion.promotionAttempts,
          promotionsSucceeded: promotion.promotionsSucceeded,
          // Per-family breakdown of the same totals — operators read
          // this to see which intent families were exercised. Wired
          // families: wait_until, schedule (LLM-extracted) and mcp_tool
          // (deterministic id match); future families add a new key here
          // without breaking existing readers.
          promotionsByFamily: promotion.promotionsByFamily,
        } });
        return sendJson(res, withBudgetWarning({
          mode: "ai",
          model: genModel,
          provider: genProvider,
          candidateCount,
          ...(bonBackoff ? { bonBackoff } : {}),
          ...workflow,
        }, budgetGate));
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI request failed";
        await auditAction(auth, "ai.workflow.generated", { targetType: "ai", targetId: fallbackWorkflow?.id, metadata: { mode: "fallback", error: message, generationMode: orgConfig.ai.generationMode, repairAttempts, candidateCount, validCandidates, bonBackoff, exemplarCount: exemplars.count, exemplarIds: exemplars.ids } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: message,
          candidateCount,
          ...(bonBackoff ? { bonBackoff } : {}),
          ...(fallbackWorkflow ?? {}),
        }, budgetGate));
      }
    } },
];
