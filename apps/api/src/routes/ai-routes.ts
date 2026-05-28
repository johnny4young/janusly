/**
 * AI mutation surfaces. Every route follows the AI-fallback contract:
 * wrap the LLM call in try/catch, degrade to `{ mode: "fallback",
 * aiError, ... }` with deterministic content on any failure (quota,
 * rate, network, bad output, missing API key for an override).
 *
 * Audit invariant: every AI mutation writes an `audit_logs` row on
 * AI-mode AND fallback. Per the AGENTS.md AI-mutation contract,
 * `/ai/review-workflow`, `/ai/patch-workflow`, and
 * `/ai/suggest-improvement` audit on both paths;
 * `/ai/generate-workflow` and `/ai/explain-workflow` audit on AI-mode
 * success only.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { explainRun, promoteNoopPlaceholders, RUN_EVENT_PROMPT_CAP, STRUCTURAL_PATCH_SYSTEM_PROMPT, suggestWorkflowImprovement, suggestWorkflowPatch, type PatchSuggestion, type SuggestImprovementResult } from "@janusly/ai";
import { summarizePastFeedback } from "@janusly/data/src/recoveryFeedbackRepo";
import { db, runEvents, runs, workflowVersions } from "@janusly/db";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import { listTools } from "@janusly/engine/src/tool-registry";
import { buildReviewFallback, mergeReviewFindings, sanitizeAiReview, type ReviewFindings } from "@janusly/engine/src/workflow-review-fallback";
import { hasApprovalAncestor, isSensitiveAction } from "@janusly/engine/src/workflow-readiness";
import { NodeSchema, WorkflowSchema, type Workflow } from "@janusly/shared";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { composeFeedbackHint } from "../ai-patch-feedback";
import { composeRecoveryMemoryHint } from "../ai-recovery-memory";
import { composeGenerationSystemPrompt, GENERATE_WORKFLOW_SYSTEM_PROMPT, REVIEW_WORKFLOW_SYSTEM_PROMPT } from "../ai-prompts";
import { listExposedMcpToolsForAi } from "@janusly/data/src/mcpConnectionsRepo";
import { aiStatus, fallbackExplainWorkflow, fallbackWorkflowForPrompt, orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { AiGenerationWorkflowSchema, AiPatchStructuralEnvelope, AiSuggestImprovementEnvelope, patchEnvelopeForNodeType, ReviewFindingsSchema, type AiPatchStructuralSuggestion } from "../ai-schemas";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendJson } from "../http";
import { applyConfigPatchToWorkflow, applyStructuralPatchToWorkflow } from "../patch-workflow-merge";
import { enforceRateLimit } from "../rate-limit";
import { attachBudgetEnvelope, budgetBlockedResponse, gateBudget, type GateBudgetOutcome } from "../budget-gate";
import { localeFromRequest } from "../locale";
import type { Route } from "../routes";

function withBudgetWarning<T extends Record<string, unknown>>(response: T, budgetGate: GateBudgetOutcome): T {
  return budgetGate.envelope.warningThresholdCrossed
    ? attachBudgetEnvelope(response, budgetGate.envelope)
    : response;
}

export const aiRoutes: Route[] = [
  // AI helpers
  { method: "GET", match: "/ai/health",
    handler: async ({ res, auth }) => sendJson(res, await aiStatus(auth.orgId)) },
  { method: "POST", match: "/ai/generate-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const promptText = typeof body.prompt === "string" ? body.prompt : "";
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      if (promptText.length > orgConfig.ai.promptMaxChars) {
        return sendJson(res, { error: `prompt exceeds ${orgConfig.ai.promptMaxChars} characters` }, 413);
      }
      // No workflowId yet — /ai/generate-workflow drafts a brand new flow.
      // Only the org-level budget gate applies on this path.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.workflow.generated" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const fallbackWorkflow = fallbackWorkflowForPrompt(promptText);
      if (!llm) {
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          ...(fallbackWorkflow ?? {}),
        }, budgetGate));
      }
      try {
        // Schema-aware generation. The AI SDK plumbs the slim
        // `AiGenerationWorkflowSchema` through each provider's
        // structured-output capability and validates the response. The
        // shape-coercing `looseAiWorkflow` pre-pass that existed before this
        // is gone — schema enforcement is now real. Failures (LLM emits
        // non-conformant JSON) throw inside the SDK and flow through the
        // existing try/catch into the fallback contract.
        // Org-level admins can opt MCP connections into LLM exposure via
        // the `exposeToAi` flag. When present, the connection's enabled
        // tool descriptors (with sanitised descriptions) are appended to
        // the system prompt as DATA so the LLM can reference them when
        // emitting `noop` placeholders the operator promotes later. The
        // composer is a no-op when nothing is exposed → identical
        // behaviour to today for non-opt-in orgs.
        const exposedMcpTools = await listExposedMcpToolsForAi(auth.orgId);
        const systemPrompt = composeGenerationSystemPrompt(GENERATE_WORKFLOW_SYSTEM_PROMPT, exposedMcpTools);
        const result = await llm.generateObject<z.infer<typeof AiGenerationWorkflowSchema>>({
          schema: AiGenerationWorkflowSchema,
          schemaName: "JanuslyWorkflow",
          schemaDescription: "Workflow DAG for /ai/generate-workflow.",
          system: systemPrompt,
          prompt: promptText,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId },
        });
        // Cast: the AI-side discriminated-union node configs are strict
        // subsets of the engine's loose `config: Record<string, unknown>`,
        // so the inferred AI shape structurally satisfies `Workflow`. The
        // post-validation `sanitizeAiWorkflow` re-parses through
        // `WorkflowSchema` so a bad cast can never reach persistence.
        const pass1Workflow = result.object as unknown as Workflow;

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
          modelHint: modelOverride,
        });

        const workflow = sanitizeAiWorkflow(promotion.workflow);
        await auditAction(auth, "ai.workflow.generated", { targetType: "ai", targetId: workflow.id, metadata: {
          mode: "ai",
          model: result.model,
          provider: result.provider,
          promotionAttempts: promotion.promotionAttempts,
          promotionsSucceeded: promotion.promotionsSucceeded,
          // Per-family breakdown of the same totals — operators read
          // this to see which intent families the LLM exercised. Wait
          // and schedule are the only wired families today; future
          // families add a new key here without breaking existing readers.
          promotionsByFamily: promotion.promotionsByFamily,
        } });
        return sendJson(res, withBudgetWarning({ mode: "ai", model: result.model, provider: result.provider, ...workflow }, budgetGate));
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI request failed";
        await auditAction(auth, "ai.workflow.generated", { targetType: "ai", targetId: fallbackWorkflow?.id, metadata: { mode: "fallback", error: message } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: message,
          ...(fallbackWorkflow ?? {}),
        }, budgetGate));
      }
    } },
  { method: "POST", match: "/ai/explain-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const { workflow } = body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const explainWorkflowIdEarly = workflow && typeof workflow === "object" && "id" in (workflow as object) && typeof (workflow as { id?: unknown }).id === "string" ? (workflow as { id: string }).id : undefined;
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, workflowId: explainWorkflowIdEarly, action: "ai.workflow.explained" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      if (!llm) {
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          explanation: fallbackExplainWorkflow(workflow),
        }, budgetGate));
      }
      try {
        const explainWorkflowId = (workflow && typeof workflow === "object" && "id" in workflow && typeof (workflow as { id?: unknown }).id === "string")
          ? (workflow as { id: string }).id
          : undefined;
        const explainLocale = localeFromRequest(req);
        const explainLocaleSuffix = explainLocale === "es"
          ? "\n\nIMPORTANT — RESPONSE LANGUAGE: write the explanation in Spanish. Keep node ids, type literals (`http`, `ai`, `tool`), and template tokens (`{{secret.NAME}}`, `{{context.foo.output.bar}}`) verbatim — they are workflow-DSL identifiers, not display text."
          : "";
        const result = await llm.generateText({
          prompt: `You are a workflow assistant. Explain this DAG clearly with bullet points covering purpose, flow, and any noteworthy nodes:\n${JSON.stringify(workflow, null, 2)}${explainLocaleSuffix}`,
          modelHint: modelOverride,
          context: { orgId: auth.orgId, userId: auth.userId, workflowId: explainWorkflowId },
        });
        await auditAction(auth, "ai.workflow.explained", { targetType: "ai", metadata: { mode: "ai", model: result.model, provider: result.provider } });
        return sendJson(res, withBudgetWarning({ mode: "ai", model: result.model, provider: result.provider, explanation: result.text }, budgetGate));
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI request failed";
        await auditAction(auth, "ai.workflow.explained", { targetType: "ai", metadata: { mode: "fallback", error: message } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: message,
          explanation: fallbackExplainWorkflow(workflow),
        }, budgetGate));
      }
    } },

  // AI second-pass workflow review. Sister to the deterministic readiness
  // gate at /workflows/readiness — this calls the LLM with a structured-
  // output schema to surface semantic issues rules can't see (ambiguous
  // prompts, PII risk, malformed-but-shape-valid tool inputs). Falls back
  // to the deterministic readiness check when LLM is unavailable so the
  // route always returns useful findings — `mode: "fallback"` flags the
  // source per the AGENTS.md AI-fallback contract.
  { method: "POST", match: "/ai/review-workflow",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
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
          modelHint: modelOverride,
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

  // Failure recovery — suggest workflow patches for a failing DLQ entry.
  // Dispatches to a per-failing-node-type envelope schema that wraps
  // 1-3 config-only suggestions. Each envelope stays a single non-union
  // shape so the LLM call works against both Anthropic (compiled-grammar
  // cap) and OpenAI (strict-mode `oneOf` ban). The route composes each
  // suggested workflow server-side by merging into the original snapshot,
  // then re-validates through the same `WorkflowSchema.safeParse` +
  // `sanitizeAiWorkflow` chain `/ai/generate-workflow` uses. Audits both
  // AI-mode and fallback paths per the AGENTS.md AI-mutation contract.
  { method: "POST", match: "/ai/patch-workflow", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendJson(res, { error: "deadLetterId is required" }, 400);
      // Org-level budget gate on recovery routes. The per-workflow gate
      // would need the workflowId resolved from the DLQ's run, which we
      // load below — gating after that load would let an over-budget org
      // still spend on the load. Org-level here is the right cut.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.workflow.patch_suggested" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      // Multi-tenant gate via the existing repo helper.
      const dlq = await getDeadLetter(auth.orgId, deadLetterId);
      if (!dlq) return sendJson(res, { error: "DLQ entry not found" }, 404);

      // Recent events around the failure for run context. Multi-tenant
      // scope flows through runs.orgId on the run row.
      const run = await db.select().from(runs).where(eq(runs.id, dlq.runId));
      if (!run[0] || run[0].orgId !== auth.orgId) {
        return sendJson(res, { error: "Run not found" }, 404);
      }
      const events = (await db
        .select({
          type: runEvents.type,
          nodeId: runEvents.nodeId,
          payload: runEvents.payload,
          createdAt: runEvents.createdAt,
        })
        .from(runEvents)
        .where(eq(runEvents.runId, dlq.runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(RUN_EVENT_PROMPT_CAP)).reverse();

      // Pick the per-type envelope based on the failing node's type.
      // The typed envelopes wrap a `suggestions` array of 1-3 items —
      // single repeated shape, no full-workflow union — so the compiled
      // grammar stays small for Anthropic and the JSON Schema has no
      // `oneOf` keyword (works for OpenAI strict mode too).
      const failingNode = NodeSchema.safeParse(dlq.nodeJson);
      const failingNodeType = failingNode.success ? failingNode.data.type : "unknown";
      const configEnvelope = patchEnvelopeForNodeType(failingNodeType);

      // Structural-patch dispatch: when the failing node is a write-side
      // HTTP call with no human-approval ancestor in the upstream DAG,
      // route to the structural envelope so the LLM proposes a node-graph
      // patch (insert an approval upstream) instead of a config tweak.
      // Reuses the same `isSensitiveAction` + `hasApprovalAncestor` rule
      // that drives the readiness check, so dispatch is consistent with
      // what the operator sees flagged on the Production Readiness badge.
      // Covers HTTP write-side AND every `mcp_tool` node. Classic `tool`
      // nodes (against `SENSITIVE_TOOL_NAMES` / `SENSITIVE_TOOL_SUFFIXES`)
      // stay on the config envelope — the operator UX for "insert approval
      // upstream of slack.post / email.send" hasn't been validated yet.
      const parsedWorkflowForDispatch = WorkflowSchema.safeParse(dlq.workflowJson);
      const useStructural =
        failingNode.success
        && (failingNode.data.type === "http" || failingNode.data.type === "mcp_tool")
        && isSensitiveAction(failingNode.data)
        && parsedWorkflowForDispatch.success
        && !hasApprovalAncestor(
          dlq.nodeId,
          parsedWorkflowForDispatch.data.edges,
          parsedWorkflowForDispatch.data.nodes,
          new Map(),
        );

      const envelope = useStructural
        ? { schema: AiPatchStructuralEnvelope, kind: "structural" as const }
        : configEnvelope;

      // Tool-typed failures benefit from per-tool field-name hints —
      // the LLM otherwise has to infer required input field names from
      // a possibly-misleading runtime error message. The tool registry's
      // `listTools()` already produces the operator-facing description
      // (`required` / `optional` / `inputExample`); pluck the entry for
      // the failing node's tool and pass it through `extraContext`.
      // Returns undefined for non-tool failures, unknown tools, or
      // failing nodes without a `config.tool` string — the helper
      // omits the field in those cases.
      const toolInputContract = (() => {
        if (envelope.kind !== "tool") return undefined;
        const failingNodeJson = dlq.nodeJson as { config?: { tool?: unknown } } | null;
        const toolName = typeof failingNodeJson?.config?.tool === "string" ? failingNodeJson.config.tool : null;
        if (!toolName) return undefined;
        const entry = listTools().find((tool) => tool.name === toolName);
        if (!entry) return undefined;
        return {
          name: entry.name,
          description: entry.description,
          required: entry.required,
          optional: entry.optional ?? [],
          inputExample: entry.inputExample,
        };
      })();

      // Past-feedback enrichment — the operator → system half of the
      // recovery loop. If the failing workflow has a saved id, look up
      // the operator's recent accept/reject decisions for it and slip
      // a one-line summary into the prompt as soft prior, so the LLM
      // can deprioritize approaches the operator has already rejected.
      // Returns "" for first-time recoveries (no rows match) — the
      // prompt then has the same shape it had pre-enrichment.
      const failingWorkflowJson = dlq.workflowJson as { id?: unknown } | null;
      const failingWorkflowId = typeof failingWorkflowJson?.id === "string" ? failingWorkflowJson.id : null;
      const pastFeedbackSummary = failingWorkflowId
        ? composeFeedbackHint(await summarizePastFeedback(auth.orgId, failingWorkflowId))
        : "";

      // Memory-assisted recovery: when org memory is enabled, recall a
      // small bounded set of similar prior failures + accepted/rejected
      // fixes scoped to the same org (and preferably workflow) and slip
      // them into the prompt as DATA, not instructions. The helper
      // short-circuits BEFORE any `recallMemory` invocation when memory
      // is disabled, so memory-disabled orgs see zero new audit rows,
      // zero new usage_events rows, and zero new DB reads against
      // `memory_entries` — the "memory-disabled zero behavior change"
      // invariant. When the substrate is empty (e.g. no past feedback
      // has been committed yet), the helper returns an empty hint and
      // the conditional spread below keeps the `extraContext` shape
      // byte-for-byte identical to the pre-enrichment case.
      const memoryHint = failingNode.success
        ? await composeRecoveryMemoryHint({
            orgId: auth.orgId,
            workflowId: failingWorkflowId,
            failingNode: { id: failingNode.data.id, type: failingNode.data.type },
            errorEnvelope: dlq.errorJson,
          })
        : { snippets: "", hitCount: 0, recallOk: true };

      const extraContext: Record<string, unknown> = {
        ...(toolInputContract ? { toolInputContract } : {}),
        ...(pastFeedbackSummary ? { pastFeedbackSummary } : {}),
        ...(memoryHint.snippets ? { memorySnippets: memoryHint.snippets } : {}),
      };

      // Cast: the structural envelope's `suggestions` items have a
      // different shape than the config-shape `PatchEnvelopeSchemaResult`
      // the helper's TS signature expects. The runtime contract is the
      // same — `{ suggestions: Array<...> }` — and the route's per-
      // suggestion merger handles the actual field shapes downstream.
      // Cast through `any` because the helper's input type is a single
      // FlexibleSchema and our envelope union mixes two incompatible
      // item shapes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelopeSchemaAny: any = envelope.schema;

      const helperResult: PatchSuggestion = await suggestWorkflowPatch({
        llm,
        envelopeSchema: envelopeSchemaAny,
        workflow: dlq.workflowJson,
        failedNodeId: dlq.nodeId,
        errorJson: safePersistPayload(dlq.errorJson ?? null),
        extraContext: Object.keys(extraContext).length > 0 ? extraContext : undefined,
        context: { orgId: auth.orgId, userId: auth.userId, workflowId: failingWorkflowId ?? undefined },
        // Operator locale flows from the web's `Accept-Language` header
        // through the route into the LLM helper so the rationale (and,
        // for the structural envelope, the approvalMessage) come back in
        // the operator's display language. Machine-contract fields stay
        // English (see `localeInstructionForLlm`).
        locale: localeFromRequest(req),
        // Structural envelope changes the LLM's output shape — it emits
        // `action`/`approvalNodeId`/`approvalMessage`/`insertBeforeNodeId`
        // instead of `patchedConfig`. The helper stays schema-agnostic and
        // just hands the suggestions back verbatim; the route applies the
        // right merger downstream based on `useStructural`.
        systemPromptOverride: useStructural ? STRUCTURAL_PATCH_SYSTEM_PROMPT : undefined,
        // Pass every event payload through the persistence chokepoint
        // before it leaves the API boundary. `safe-persist` was applied at
        // write time which key-redacted known sensitive keys, but free-form
        // value content (e.g. an `http` node's response body) survives
        // verbatim — a re-application here scrubs any nested
        // sensitive-keyed fields that landed inside an inner object since
        // the original write. Defense in depth: never ship the prompt to a
        // remote LLM with un-scrubbed payloads.
        runEvents: events.map((event) => ({
          type: event.type,
          nodeId: event.nodeId ?? null,
          payload: safePersistPayload(event.payload ?? null),
          createdAt: event.createdAt ?? null,
        })),
      });

      // Fan-out merge: each helper-emitted suggestion goes through the
      // strict `WorkflowSchema` + `sanitizeAiWorkflow` chain that the
      // single-suggestion path used. Suggestions that fail validation
      // are dropped without breaking the rest of the batch. Survivors
      // are sorted by confidence desc so the dialog's default tab is
      // the model's most-confident pick.
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
        model?: string;
        provider?: string;
        aiError?: string;
      };

      if (helperResult.mode === "ai") {
        const originalParsed = WorkflowSchema.safeParse(dlq.workflowJson);
        const validated: ValidatedSuggestion[] = [];
        if (originalParsed.success) {
          for (const rawItem of helperResult.suggestions) {
            try {
              let merged: Workflow;
              if (useStructural) {
                // Cast: the helper's TS return type is the config-only
                // `PatchSuggestionItem`, but the structural envelope's
                // schema validated a different shape at parse time. The
                // applier validates the runtime fields itself and throws
                // if anything is missing — which the catch below drops.
                const structuralItem = rawItem as unknown as AiPatchStructuralSuggestion;
                merged = applyStructuralPatchToWorkflow(originalParsed.data, {
                  action: structuralItem.action,
                  approvalNodeId: structuralItem.approvalNodeId,
                  approvalMessage: structuralItem.approvalMessage,
                  insertBeforeNodeId: structuralItem.insertBeforeNodeId,
                }, dlq.nodeId);
              } else {
                merged = applyConfigPatchToWorkflow(originalParsed.data, dlq.nodeId, rawItem.patchedConfig);
              }
              const sanitized = sanitizeAiWorkflow(merged);
              validated.push({
                workflow: sanitized,
                rationale: rawItem.rationale,
                approachLabel: rawItem.approachLabel,
                confidence: rawItem.confidence,
              });
            } catch {
              // Drop this suggestion; keep going. If none survive, the
              // empty-list branch below degrades to fallback.
            }
          }
          validated.sort((a, b) => b.confidence - a.confidence);
        }

        if (validated.length > 0) {
          const top = validated[0]!;
          response = {
            mode: "ai",
            // Back-compat: legacy callers reading these top-level fields
            // see the highest-confidence suggestion's content. The new UI
            // reads the `suggestions` array directly.
            suggestedWorkflow: top.workflow,
            rationale: top.rationale,
            suggestions: validated,
            model: helperResult.model,
            provider: helperResult.provider,
          };
        } else {
          // No suggestion survived validation — degrade to fallback.
          const reason = originalParsed.success
            ? "All AI suggestions failed validation."
            : `Original workflow failed strict schema: ${originalParsed.error.issues[0]?.message ?? "unknown"}`;
          response = {
            mode: "fallback",
            suggestedWorkflow: dlq.workflowJson,
            rationale: `AI returned suggestions that could not be applied safely. The original workflow is unchanged. Reason: ${reason}`,
            suggestions: [{
              workflow: dlq.workflowJson as Workflow,
              rationale: `AI returned suggestions that could not be applied safely. ${reason}`,
              approachLabel: "other",
              confidence: 0,
            }],
            model: helperResult.model,
            provider: helperResult.provider,
            aiError: helperResult.aiError ?? "no_valid_suggestions",
          };
        }
      } else {
        const fallbackItem = helperResult.suggestions[0]!;
        response = {
          mode: "fallback",
          suggestedWorkflow: dlq.workflowJson,
          rationale: fallbackItem.rationale,
          suggestions: [{
            workflow: dlq.workflowJson as Workflow,
            rationale: fallbackItem.rationale,
            approachLabel: fallbackItem.approachLabel,
            confidence: fallbackItem.confidence,
          }],
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      await auditAction(auth, "ai.workflow.patch_suggested", { targetType: "dlq", targetId: deadLetterId, metadata: {
        mode: response.mode,
        model: response.model,
        provider: response.provider,
        aiError: response.aiError,
        envelopeKind: envelope.kind,
        // patchStyle distinguishes structural (node-graph patches like
        // inserting an approval upstream) from config_only (single-node
        // field changes). Existing audit readers ignore the new field.
        patchStyle: useStructural ? "structural" : "config_only",
        suggestionsCount: response.suggestions.length,
        topApproachLabel: response.suggestions[0]?.approachLabel,
        // `runId` is set so report exports can auto-discover the most
        // recent patch suggestion for a given run by metadata lookup.
        // The audit row's `targetId` is the dlq id (already populated
        // above), so adding `runId` to metadata is the cross-reference.
        runId: dlq.runId,
        // Memory enrichment counters (no raw content — the snippets
        // string never lands in the audit row). `memoryHitCount` is
        // the number of rendered entries (0 when memory is disabled,
        // the substrate is empty, or every recall returned empty for
        // any reason). `memoryRecallOk` flags whether the consent gate
        // was passed: `false` means memory is disabled (process flag,
        // tenant flag, or config_unavailable fail-closed); `true`
        // means consent was allowed and the recall calls returned —
        // for actual recall failure diagnosis, cross-reference the
        // `memory.recall.failed` audit rows the repo writes per
        // failure with the specific `reason`.
        memoryHitCount: memoryHint.hitCount,
        memoryRecallOk: memoryHint.recallOk,
      } });

      return sendJson(res, withBudgetWarning(response, budgetGate));
    } },

  // Authoring assistant — suggest 1-3 high-impact improvements to a
  // workflow snapshot the operator is currently reviewing in the
  // Compare panel. Sister to /ai/patch-workflow but operates without a
  // failing-node id and emits FULL workflow snapshots (the diff renderer
  // already handles add/remove/changed rows). The route validates each
  // suggestion through the same `WorkflowSchema.safeParse` +
  // `sanitizeAiWorkflow` chain `/ai/generate-workflow` uses, drops
  // invalid suggestions, sorts survivors by confidence desc, and
  // degrades to fallback when none survive. Audits both AI-mode and
  // fallback paths per the AGENTS.md AI-mutation contract. Read-only
  // by design — the route never mutates workflows; the operator applies
  // a chosen suggestion through the existing /workflows/save flow.
  { method: "POST", match: "/ai/suggest-improvement", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const candidate = (body.workflow && typeof body.workflow === "object") ? asRecord(body.workflow) : body;
      const focus = typeof body.focus === "string" ? body.focus : undefined;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
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
      const helperResult: SuggestImprovementResult = await suggestWorkflowImprovement({
        llm,
        envelopeSchema: AiSuggestImprovementEnvelope,
        workflow,
        focus,
        model: modelOverride,
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
            const sanitized = sanitizeAiWorkflow(reparsed.data);
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
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      await auditAction(auth, "ai.workflow.improvement_suggested", { targetType: "ai", targetId: workflow.id, metadata: {
        mode: response.mode,
        model: response.model,
        provider: response.provider,
        aiError: response.aiError,
        suggestionsCount: response.suggestions.length,
        topApproachLabel: response.suggestions[0]?.approachLabel,
        focusProvided: typeof focus === "string" && focus.trim().length > 0,
      } });

      return sendJson(res, withBudgetWarning(response, budgetGate));
    } },

  { method: "POST", match: "/ai/explain-run",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const { runId, question } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string") return sendJson(res, { error: "runId is required" }, 400);
      const questionText = typeof question === "string" ? question : undefined;
      if (questionText && questionText.length > orgConfig.ai.promptMaxChars) {
        return sendJson(res, { error: `question exceeds ${orgConfig.ai.promptMaxChars} characters` }, 413);
      }
      // Org-level budget gate. The workflowId is on the run row we load
      // below, but the run lookup itself is cheap and gating at org-level
      // matches the recovery-path posture for /ai/patch-workflow.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.run.explained" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Run not found" }, 404);

      // Resolve the workflow id via the same join `getRunMetadata` uses
      // so the recorder can attribute usage rows to the workflow. The
      // join is multi-tenant scoped via the prior `run[0].orgId` check.
      const versionRow = await db
        .select({ workflowId: workflowVersions.workflowId })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, run[0].workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const explainRunWorkflowId = versionRow[0]?.workflowId ?? undefined;

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      const result = await explainRun({
        llm,
        run: run[0],
        events,
        question: questionText,
        context: { orgId: auth.orgId, userId: auth.userId, runId, workflowId: explainRunWorkflowId },
        // See `/ai/patch-workflow` for the locale propagation rationale.
        locale: localeFromRequest(req),
      });
      await auditAction(auth, "ai.run.explained", { targetType: "run", targetId: runId, metadata: {
        mode: result.mode,
        model: result.model,
        provider: result.provider,
        aiError: result.aiError,
      } });
      return sendJson(res, withBudgetWarning(result, budgetGate));
    } },
];
