/**
 * `POST /ai/patch-workflow` — failure-recovery patch suggestions for a
 * failing DLQ entry (`role: "editor"`).
 *
 * Dispatches to a per-failing-node-type envelope schema (config-only, or the
 * structural envelope that inserts an approval upstream of an unguarded
 * write-side call), composes each suggested workflow server-side by merging
 * into the original snapshot, then re-validates through the same
 * `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` chain
 * `/ai/generate-workflow` uses. Upholds the AI-fallback contract: the helper
 * returns `{ mode: "ai" | "fallback", ... }` and the route degrades to
 * `mode: "fallback"` (original workflow unchanged, `aiError` populated) when
 * the LLM fails or no suggestion survives validation. Per the AGENTS.md
 * AI-mutation contract this surface audits BOTH the AI-mode and fallback
 * paths.
 */
import { desc, eq } from "drizzle-orm";

import { RUN_EVENT_PROMPT_CAP, STRUCTURAL_PATCH_SYSTEM_PROMPT, suggestWorkflowPatch, type PatchSuggestion } from "@janusly/ai";
import {
  summarizePastFeedback,
  findLatestOutcomeBySignature,
  listCalibrations,
  queryRecoveryFeedbackHealth,
  type RecoveryFeedbackHealthSnapshot,
  type StoredCalibration,
} from "@janusly/data";
import { db, runEvents, runs } from "@janusly/db";
import { applyCalibration, type CalibrationCurve } from "@janusly/engine/src/confidence-calibration";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import { listTools } from "@janusly/engine/src/tool-registry";
import { hasApprovalAncestor, isSensitiveAction } from "@janusly/engine/src/workflow-readiness";
import { NodeSchema, WorkflowSchema, type EvidenceRow, type Workflow } from "@janusly/shared";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { assembleRecoveryEvidence } from "../ai-evidence";
import { composeFeedbackHint } from "../ai-patch-feedback";
import { composeRecoveryMemoryHint } from "../ai-recovery-memory";
import { orgLlmRuntime, resolveSurfaceModel, sanitizeAiWorkflow } from "../ai-runtime";
import { AiPatchStructuralEnvelope, patchEnvelopeForNodeType, type AiPatchStructuralSuggestion } from "../ai-schemas";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { applyConfigPatchToWorkflow, applyStructuralPatchToWorkflow } from "../patch-workflow-merge";
import { enforceRateLimit } from "../rate-limit";
import { budgetBlockedResponse, gateBudget } from "../budget-gate";
import { localeFromRequest } from "../locale";
import { withBudgetWarning } from "../ai-route-helpers";
import type { Route } from "../routes";
import { recoverySuggestionSafety, type RecoverySuggestionSafety } from "../recovery-suggestion-safety";

/**
 * Index the stored calibration curves by `approachLabel` for O(1) lookup
 * when calibrating each suggestion. The repo's `sampleSize` IS the
 * threshold gate — the daily sweep only persists a row when the fit
 * cleared `MIN_CALIBRATION_SAMPLES`, so any present row is trustworthy.
 * Returns an empty map when calibration is disabled for the org or no
 * curve has been fit yet, in which case every suggestion's calibrated
 * value falls back to its raw confidence.
 */
function indexCalibrationCurves(rows: StoredCalibration[]): Map<string, CalibrationCurve> {
  const byApproach = new Map<string, CalibrationCurve>();
  for (const row of rows) {
    byApproach.set(row.approachLabel, {
      slope: row.curveSlope,
      intercept: row.curveIntercept,
      sampleSize: row.sampleSize,
      acceptRate: row.acceptRate,
    });
  }
  return byApproach;
}

export const aiPatchRoutes: Route[] = [
  { method: "POST", match: "/ai/patch-workflow", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "patch-workflow", modelOverride);
      const deadLetterId = typeof body.deadLetterId === "string" ? body.deadLetterId : null;
      if (!deadLetterId) return sendError(res, "ai_dead_letter_id_required", "deadLetterId is required", 400);
      // Org-level budget gate on recovery routes. The per-workflow gate
      // would need the workflowId resolved from the DLQ's run, which we
      // load below — gating after that load would let an over-budget org
      // still spend on the load. Org-level here is the right cut.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.workflow.patch_suggested" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      // Multi-tenant gate via the existing repo helper.
      const dlq = await getDeadLetter(auth.orgId, deadLetterId);
      if (!dlq) return sendError(res, "dlq_not_found", "DLQ entry not found", 404);

      // Recent events around the failure for run context. runEvents has no
      // orgId column; the read below is org-safe because the run row is gated
      // to auth.orgId immediately here (404 otherwise) and runs are never
      // deleted — a cross-tenant runId cannot reach the runEvents query.
      const run = await db.select().from(runs).where(eq(runs.id, dlq.runId));
      if (!run[0] || run[0].orgId !== auth.orgId) {
        return sendError(res, "ai_run_not_found", "Run not found", 404);
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

      // Confidence calibration: when enabled for the org, load the
      // per-approach curves the daily sweep fitted from this org's
      // recovery feedback. Each suggestion's raw self-rated confidence is
      // mapped through the matching curve below to emit a calibrated value
      // alongside the raw one. Disabled → empty map → calibrated mirrors
      // raw exactly (zero behavior change). Best-effort read: a DB blip
      // degrades to "no calibration" (raw shown unchanged) rather than
      // failing the recovery flow.
      let calibrationCurves = new Map<string, CalibrationCurve>();
      if (orgConfig.ai.confidenceCalibrationEnabled) {
        try {
          calibrationCurves = indexCalibrationCurves(await listCalibrations(auth.orgId));
        } catch {
          calibrationCurves = new Map();
        }
      }

      // Pick the per-type envelope based on the failing node's type.
      // The typed envelopes wrap a `suggestions` array of 1-3 items —
      // single repeated shape, no full-workflow union — so the compiled
      // grammar stays small for Anthropic and the JSON Schema has no
      // `oneOf` keyword (works for OpenAI strict mode too).
      const failingNode = NodeSchema.safeParse(dlq.nodeJson);
      const failingNodeType = failingNode.success ? failingNode.data.type : "unknown";
      const failureSignature = normalizeErrorSignature(dlq.errorJson, {
        nodeId: dlq.nodeId,
        nodeType: failingNode.success ? failingNode.data.type : undefined,
      }).signature;
      const priorSameSignatureOutcome = await findLatestOutcomeBySignature(
        auth.orgId,
        failureSignature,
        deadLetterId,
      ).then((row) => row ? ({
        status: row.status,
        approachLabel: row.approachLabel,
        declineReason: row.declineReason,
        occurredAt: row.updatedAt.toISOString(),
      }) : null).catch(() => null);
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
      // Keep the raw per-approach summaries — the prompt hint is derived
      // from them AND the evidence side-channel emits one `recovery_feedback`
      // row per decided approach. One read, two consumers.
      const feedbackSummaries = failingWorkflowId
        ? await summarizePastFeedback(auth.orgId, failingWorkflowId)
        : [];
      const pastFeedbackSummary = failingWorkflowId ? composeFeedbackHint(feedbackSummaries) : "";

      // The feedback summary above is prompt-only and intentionally returns
      // an empty array after its rolling window expires. Surface the separate
      // lifetime aggregate alongside the patch response so the dialog can
      // distinguish a cold approach from a formerly-active learning loop
      // whose accepted fixes have gone stale. This is best-effort: a health
      // read must never weaken the patch route's fallback contract.
      let feedbackHealth: RecoveryFeedbackHealthSnapshot | undefined;
      if (failingWorkflowId) {
        try {
          feedbackHealth = await queryRecoveryFeedbackHealth(auth.orgId, failingWorkflowId);
        } catch {
          feedbackHealth = undefined;
        }
      }

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
            runId: dlq.runId,
            workflowId: failingWorkflowId,
            failingNode: { id: failingNode.data.id, type: failingNode.data.type },
            errorEnvelope: dlq.errorJson,
          })
        : { snippets: "", hitCount: 0, recallOk: true, entries: [] };

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
        model: surfaceModel,
        cacheSystemPrompt: true,
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
        /** The model's raw self-rated confidence (0-100). */
        confidence: number;
        /**
         * The calibrated confidence (0-100) — `confidence` mapped through
         * the org's per-approach curve. Equals `confidence` when no curve
         * is available (calibration disabled, no fit yet, or the curve was
         * monotonicity-rejected). The recovery dialog renders this as the
         * primary number and surfaces a "(model self-rated X%)" subtitle
         * only when the two differ by ≥ CALIBRATION_SUBTITLE_DELTA points.
         */
        calibratedConfidence: number;
        /** Deterministic write-side + approval posture for this candidate. */
        safety: RecoverySuggestionSafety;
      };
      // Resolve raw + calibrated confidence for one approach. Calibration
      // is monotonic in `raw` (the fit only ever returns positive-slope
      // curves), so applying it can never re-order suggestions relative to
      // their raw ranking — the sort below stays on `confidence` (raw) to
      // preserve the exact ordering the AC's monotonicity case asserts.
      const calibrate = (approachLabel: string, rawConfidence: number): number =>
        applyCalibration(rawConfidence, calibrationCurves.get(approachLabel) ?? null);
      let response: {
        mode: "ai" | "fallback";
        suggestedWorkflow: Workflow | unknown;
        rationale: string;
        suggestions: ValidatedSuggestion[];
        /** "Why this suggestion?" side-channel — the context the composer
         *  fed the model, scrubbed at read time. Possibly empty. Populated
         *  below after the response shape is settled (it is the same on the
         *  AI and fallback paths — the operator can still see what context
         *  was available even when the LLM degraded). */
        evidence: EvidenceRow[];
        /** Freshness of the operator feedback loop for the failing workflow. */
        feedbackHealth?: RecoveryFeedbackHealthSnapshot;
        recoveryPassport: {
          failureSignature: string;
          priorSameSignatureOutcome: {
            status: string;
            approachLabel: string | null;
            declineReason: string | null;
            occurredAt: string;
          } | null;
        };
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
                calibratedConfidence: calibrate(rawItem.approachLabel, rawItem.confidence),
                safety: recoverySuggestionSafety(sanitized, dlq.nodeId),
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
            evidence: [],
            recoveryPassport: { failureSignature, priorSameSignatureOutcome },
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
              calibratedConfidence: 0,
              safety: recoverySuggestionSafety(dlq.workflowJson, dlq.nodeId),
            }],
            evidence: [],
            recoveryPassport: { failureSignature, priorSameSignatureOutcome },
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
            calibratedConfidence: calibrate(fallbackItem.approachLabel, fallbackItem.confidence),
            safety: recoverySuggestionSafety(dlq.workflowJson, dlq.nodeId),
          }],
          evidence: [],
          recoveryPassport: { failureSignature, priorSameSignatureOutcome },
          model: helperResult.model,
          provider: helperResult.provider,
          aiError: helperResult.aiError,
        };
      }

      // Evidence side-channel ("Why this suggestion?"). Deterministic
      // projection of the SAME context the prompt composer gathered — no
      // second LLM call. Populated on BOTH the AI and fallback paths so the
      // operator can see what context was available even when the model
      // degraded. Best-effort: the assembler swallows its two supplemental
      // reads' failures (runbook + recent-error scan) and the per-source
      // builders are pure, so a DB blip degrades to a shorter list, never a
      // 500. The shared `scrubEvidenceRows` re-scrubs every snippet at read
      // time and caps the count. `failingNode` may have failed to parse
      // (corrupt `nodeJson`) — pass the loose shape through so the signature
      // rule still fires off `dlq.errorJson`.
      const evidenceFailingNode = failingNode.success
        ? { type: failingNode.data.type, id: failingNode.data.id, toolName: toolInputContract?.name }
        : (typeof (dlq.nodeJson as { type?: unknown } | null)?.type === "string"
            ? { type: (dlq.nodeJson as { type?: string }).type, id: dlq.nodeId }
            : { id: dlq.nodeId });
      response.evidence = await assembleRecoveryEvidence({
        orgId: auth.orgId,
        workflowId: failingWorkflowId,
        runId: dlq.runId,
        failingNode: evidenceFailingNode,
        errorJson: dlq.errorJson,
        feedbackSummaries,
        memoryEntries: memoryHint.entries,
        toolContract: toolInputContract ?? null,
      });
      response.feedbackHealth = feedbackHealth;

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
        // Confidence-calibration observability: whether the org has the
        // feature on, and how many stored curves were available at read
        // time (0 = raw shown unchanged everywhere). The actual per-tab
        // calibrated values ride the response, not the audit row.
        calibrationEnabled: orgConfig.ai.confidenceCalibrationEnabled,
        calibrationCurvesAvailable: calibrationCurves.size,
        // Evidence side-channel observability — the COUNT only. The rows
        // themselves carry scrubbed snippets that ride the response, never
        // the audit row, so a memory-entry excerpt or runbook line never
        // lands in `audit_logs.metadata`.
        evidenceCount: response.evidence.length,
      } });

      return sendJson(res, withBudgetWarning(response, budgetGate));
    } },
];
