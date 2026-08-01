/**
 * The two AI "explain" surfaces:
 *   `POST /ai/explain-workflow` — narrate a workflow DAG in prose.
 *   `POST /ai/explain-run`      — narrate/answer a question about one run.
 *
 * Both uphold the AI-fallback contract: the LLM call is wrapped so any
 * failure (or a missing provider) degrades to `{ mode: "fallback", aiError,
 * ... }` — explain-workflow via `fallbackExplainWorkflow`, explain-run via
 * the `explainRun` helper's own fallback envelope. Explain-workflow audits its
 * fallback path too so AI outages stay visible; explain-run audits every path
 * via the helper's returned mode. Neither route mutates workflow state.
 */
import { and, asc, desc, eq } from "drizzle-orm";

import { explainRun } from "@janusly/ai";
import { db, runEvents, runNodes, runs, workflowVersions } from "@janusly/db";

import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { assembleExplainRunEvidence } from "../ai-evidence";
import { fallbackExplainWorkflow, orgLlmRuntime, resolveSurfaceModel } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { budgetBlockedResponse, gateBudget } from "../budget-gate";
import { localeFromRequest } from "../locale";
import { withBudgetWarning } from "../ai-route-helpers";
import type { Route } from "../routes";

export const aiExplainRoutes: Route[] = [
  { method: "POST", match: "/ai/explain-workflow", permission: "ai.write",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const { workflow } = body;
      const modelOverride = typeof body.model === "string" ? body.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "explain-workflow", modelOverride);
      const explainWorkflowIdEarly = workflow && typeof workflow === "object" && "id" in (workflow as object) && typeof (workflow as { id?: unknown }).id === "string" ? (workflow as { id: string }).id : undefined;
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, workflowId: explainWorkflowIdEarly, action: "ai.workflow.explained" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      if (!llm) {
        const message = "AI provider not configured";
        await auditAction(auth, "ai.workflow.explained", { targetType: "ai", metadata: { mode: "fallback", error: message } });
        return sendJson(res, withBudgetWarning({
          mode: "fallback",
          aiError: message,
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
          modelHint: surfaceModel,
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

  { method: "POST", match: "/ai/explain-run", permission: "ai.write",
    handler: async ({ req, res, auth }) => {
      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      const explainRunBody = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const { runId, question } = explainRunBody;
      const modelOverride = typeof explainRunBody.model === "string" ? explainRunBody.model : undefined;
      const surfaceModel = resolveSurfaceModel(orgConfig.ai.surfaceModels, "explain-run", modelOverride);
      if (typeof runId !== "string") return sendError(res, "ai_run_id_required", "runId is required", 400);
      const questionText = typeof question === "string" ? question : undefined;
      if (questionText && questionText.length > orgConfig.ai.promptMaxChars) {
        return sendError(res, "ai_question_too_long", `question exceeds {{maxChars}} characters`, 413, { maxChars: orgConfig.ai.promptMaxChars });
      }
      // Org-level budget gate. The workflowId is on the run row we load
      // below, but the run lookup itself is cheap and gating at org-level
      // matches the recovery-path posture for /ai/patch-workflow.
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "ai.run.explained" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "ai_run_not_found", "Run not found", 404);

      // Resolve the workflow id via the same join `getRunMetadata` uses
      // so the recorder can attribute usage rows to the workflow. The
      // join is multi-tenant scoped via the prior `run[0].orgId` check.
      const versionRow = await db
        .select({ workflowId: workflowVersions.workflowId })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, run[0].workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const explainRunWorkflowId = versionRow[0]?.workflowId ?? undefined;

      // runEvents has no orgId column; this read is org-safe because the run
      // was gated to auth.orgId above (404 otherwise) and runs are never
      // deleted (cascade invariant) — a cross-tenant runId cannot reach here.
      // Don't drop the run gate above (mirrors the SSE catch-up scoping in
      // run-routes/stream.ts).
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      const result = await explainRun({
        llm,
        model: surfaceModel,
        run: run[0],
        events,
        question: questionText,
        context: { orgId: auth.orgId, userId: auth.userId, runId, workflowId: explainRunWorkflowId },
        // See `/ai/patch-workflow` for the locale propagation rationale.
        locale: localeFromRequest(req),
      });

      // Evidence side-channel — for a failed run, surface the signature rule
      // that fired on the failing node + the workflow runbook. Read the most
      // recent failed `run_nodes` row for this run (org-safe: the run row was
      // already gated to `auth.orgId`, and `run_nodes` carries no orgId so
      // the run gate IS the scope, same as the events read above). A
      // successful run has no failed node → only the runbook (if any) shows,
      // and most healthy runs yield `evidence: []`. `run_nodes` doesn't store
      // the node config, so the failing node's `type` is recovered from the
      // matching `node.failed` event payload (best-effort — the signature
      // rule still fires off `errorJson` alone when no type is found).
      const failedNodeRow = (await db
        .select({ nodeId: runNodes.nodeId, errorJson: runNodes.errorJson })
        .from(runNodes)
        .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "failed")))
        .orderBy(desc(runNodes.finishedAt))
        .limit(1))[0];
      const failedNodeType = failedNodeRow
        ? (() => {
            for (const event of events) {
              if (event.nodeId !== failedNodeRow.nodeId) continue;
              const payloadType = (event.payload as { nodeType?: unknown; type?: unknown } | null);
              if (typeof payloadType?.nodeType === "string") return payloadType.nodeType;
            }
            return undefined;
          })()
        : undefined;
      const evidence = await assembleExplainRunEvidence({
        orgId: auth.orgId,
        workflowId: explainRunWorkflowId ?? null,
        failingNode: failedNodeRow ? { id: failedNodeRow.nodeId, type: failedNodeType } : null,
        errorJson: failedNodeRow?.errorJson ?? null,
      });

      await auditAction(auth, "ai.run.explained", { targetType: "run", targetId: runId, metadata: {
        mode: result.mode,
        model: result.model,
        provider: result.provider,
        aiError: result.aiError,
        evidenceCount: evidence.length,
      } });
      // Spread the helper result (its TS type is owned by `@janusly/ai`) and
      // attach `evidence` as the route-level extension. Back-compat: legacy
      // explain-run callers ignore the new key.
      return sendJson(res, withBudgetWarning({ ...result, evidence }, budgetGate));
    } },
];
