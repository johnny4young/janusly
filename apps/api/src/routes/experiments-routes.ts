/**
 * Prompt/model experiment harness — admin route that A/B-compares a
 * CONTROL vs a CANDIDATE (prompt version, model id, or both) against an
 * org's eval dataset.
 *
 * Three routes registered into the global `routes: Route[]` registry:
 *   - `GET  /experiments`          — list paginated     (viewer, evals.read)
 *   - `GET  /experiments/:id`      — single experiment   (viewer, evals.read)
 *   - `POST /experiments/run`      — create + run        (admin,  evals.write)
 *
 * `POST /experiments/run` resolves each arm (a prompt ref → flattened
 * system prompt via the PromptOps resolver, and/or a model id → model
 * hint), budget-gates via `gateBudget`, rate-limits on the shared `"ai"`
 * bucket, creates the experiment row, runs every eval example through both
 * arms via `LlmClient.generateText` (each call writes a `usage_events` row
 * through the existing LLM-client recorder chokepoint), scores each side,
 * and writes the aggregate summary.
 *
 * Invariants enforced here:
 * - PROMOTION IS RECOMMENDATION-ONLY — the route NEVER writes to
 *   `prompts` / `prompt_versions` / `org_configs`. A favourable result
 *   only writes an `experiment.run.promotion_suggested` audit row.
 * - AI fallback contract — the runner catches per-side model failures and
 *   records `aiError`; the route's outer try/catch flips the experiment to
 *   `failed` (and still 200s with the partial summary) on an unexpected
 *   throw, never bubbling a 500 from a model-side fault.
 * - Multi-tenant scope — the dataset + experiment reads are org-scoped in
 *   the repo; the prompt resolver only reads the caller's org.
 * - `summary_json` is sanitized through `safePersistPayload` (this route
 *   owns the engine dependency; `data` can't) before the jsonb write.
 */

import { z } from "zod";

import {
  runExperiment,
  isScorerKind,
  SCORER_KINDS,
  type ExperimentArm,
  type ScorerKind,
} from "@janusly/ai";
import {
  createExperiment,
  getEvalDataset,
  getExperiment,
  isExperimentKind,
  listEvalExamples,
  listExperiments,
  recordExperimentResult,
  type ExperimentKind,
} from "@janusly/data";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import {
  resolvePromptRef,
  MissingPromptError,
  MissingPromptVersionError,
  NoPromptVersionsError,
} from "@janusly/engine/src/prompt-resolver";

import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { gateBudget, budgetBlockedResponse } from "../budget-gate";
import type { Route } from "../routes";

/** Separator between the prompt portion and the model portion of a `prompt_and_model` ref. */
const PROMPT_MODEL_SEP = "::";

/** Body for `POST /experiments/run`. */
const RunExperimentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["prompt", "model", "prompt_and_model"]),
  controlRef: z.string().trim().min(1).max(512),
  candidateRef: z.string().trim().min(1).max(512),
  evalDatasetId: z.string().min(1).max(256),
  scorerKind: z.enum(SCORER_KINDS).default("string_equality"),
  /** Optional model for the LLM judge (only consulted when scorerKind = llm_judge). */
  judgeModelHint: z.string().trim().min(1).max(256).optional(),
});

function experimentIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  const m = path.match(/^\/experiments\/([^/?]+)$/);
  return m ? m[1]! : null;
}

/** Parse a `"name@3"` / `"name"` prompt reference into the resolver's shape. */
function parsePromptRef(ref: string): { name: string; version?: number } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { name: ref };
  const versionPart = ref.slice(at + 1);
  const version = Number(versionPart);
  if (!Number.isInteger(version) || version <= 0) return { name: ref };
  return { name: ref.slice(0, at), version };
}

/**
 * Resolve one side's `ref` into a runnable arm. `prompt` → resolve the
 * prompt body into `systemPrompt`; `model` → set `modelHint`;
 * `prompt_and_model` → split on `::` and do both. Throws the prompt
 * resolver's typed errors on a bad prompt ref (the route maps them to a
 * 422). The model portion is opaque — an unknown model surfaces as a
 * per-call `aiError` during the run, not a pre-flight rejection.
 */
async function resolveArm(orgId: string, kind: ExperimentKind, ref: string): Promise<ExperimentArm> {
  if (kind === "model") {
    return { modelHint: ref };
  }
  if (kind === "prompt") {
    const resolved = await resolvePromptRef({ orgId, ref: parsePromptRef(ref) });
    return { systemPrompt: resolved.resolvedText };
  }
  // prompt_and_model: "promptName@ver::model"
  const sepIx = ref.indexOf(PROMPT_MODEL_SEP);
  const promptPart = sepIx >= 0 ? ref.slice(0, sepIx) : ref;
  const modelPart = sepIx >= 0 ? ref.slice(sepIx + PROMPT_MODEL_SEP.length) : undefined;
  const resolved = await resolvePromptRef({ orgId, ref: parsePromptRef(promptPart) });
  return { systemPrompt: resolved.resolvedText, modelHint: modelPart && modelPart.length > 0 ? modelPart : undefined };
}

export const experimentsRoutes: Route[] = [
  // GET /experiments — list the org's experiments, newest first.
  {
    method: "GET",
    match: (url) => url === "/experiments" || url.startsWith("/experiments?"),
    role: "viewer",
    permission: "evals.read",
    handler: async ({ res, auth }) => {
      const experiments = await listExperiments(auth.orgId);
      return sendJson(res, { experiments });
    },
  },

  // POST /experiments/run — create + run the comparison synchronously.
  {
    method: "POST",
    match: (url) => url === "/experiments/run" || url.startsWith("/experiments/run?"),
    role: "admin",
    permission: "evals.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = RunExperimentBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendError(res, "experiment_invalid_body", "Invalid experiment body", 400);
      }
      const { name, kind, controlRef, candidateRef, evalDatasetId, scorerKind, judgeModelHint } = parsed.data;

      // Defensive narrowing (the Zod enums already constrain, but keep the
      // repo/scorer guards as the single source of truth for the closed sets).
      if (!isExperimentKind(kind) || !isScorerKind(scorerKind)) {
        return sendError(res, "experiment_invalid_body", "Invalid experiment kind/scorer", 400);
      }

      // Resolve the dataset (org-scoped) + pull its examples up-front so an
      // empty or cross-org dataset fails BEFORE any LLM cost is incurred.
      const dataset = await getEvalDataset(auth.orgId, evalDatasetId);
      if (!dataset) {
        return sendError(res, "experiment_dataset_not_found", "Eval dataset not found", 404);
      }
      const examples = await listEvalExamples(auth.orgId, evalDatasetId);
      if (examples.length === 0) {
        return sendError(res, "experiment_dataset_empty", "Eval dataset has no examples", 422);
      }

      // Resolve both arms. A bad prompt ref is the only pre-flight rejection;
      // an unknown model surfaces as a per-call aiError during the run.
      let controlArm: ExperimentArm;
      let candidateArm: ExperimentArm;
      try {
        controlArm = await resolveArm(auth.orgId, kind, controlRef);
        candidateArm = await resolveArm(auth.orgId, kind, candidateRef);
      } catch (error) {
        if (
          error instanceof MissingPromptError ||
          error instanceof MissingPromptVersionError ||
          error instanceof NoPromptVersionsError
        ) {
          return sendError(res, "experiment_prompt_ref_invalid", "A prompt reference could not be resolved", 422, {
            reason: (error as { code?: string }).code ?? "prompt_ref_invalid",
          });
        }
        throw error;
      }

      // Budget gate BEFORE the run (the comparison fires 2 × N LLM calls).
      const budgetGate = await gateBudget({ orgId: auth.orgId, userId: auth.userId, action: "experiment.run.started" });
      if (budgetGate.blocked) return sendJson(res, budgetBlockedResponse(budgetGate.envelope), 402);

      const { orgConfig, llm } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });

      // Create the row (status: running) + audit the start.
      const experiment = await createExperiment({
        orgId: auth.orgId,
        name,
        kind,
        controlRef,
        candidateRef,
        evalDatasetId,
        scorerKind,
        createdBy: auth.userId,
      });
      await auditAction(auth, "experiment.run.started", {
        targetType: "experiment",
        targetId: experiment.id,
        metadata: { name, kind, controlRef, candidateRef, evalDatasetId, scorerKind, exampleCount: examples.length },
      });

      // Run the comparison. The runner NEVER throws on a model-side fault;
      // the outer try/catch only guards an unexpected (non-model) error so
      // the experiment is flipped to `failed` rather than left `running`.
      try {
        const summary = await runExperiment({
          client: llm,
          scorerKind: scorerKind as ScorerKind,
          controlArm,
          candidateArm,
          examples: examples.map((ex) => ({
            // The captured failure context is the prompt the model answers;
            // the operator-approved approach label is the gold outcome.
            input: ex.inputContext || ex.failureSignature,
            expected: ex.expectedApproachLabel,
          })),
          context: { orgId: auth.orgId, userId: auth.userId },
          judgeModelHint,
        });

        // Sanitize the summary (key-redaction + size-bound) before the jsonb
        // write — defense-in-depth on top of the scorer's own scrubbing.
        const safeSummary = safePersistPayload(summary as unknown as Record<string, unknown>) as Record<string, unknown>;
        const completed = await recordExperimentResult(auth.orgId, experiment.id, "completed", safeSummary);

        await auditAction(auth, "experiment.run.completed", {
          targetType: "experiment",
          targetId: experiment.id,
          metadata: {
            scorerKind,
            exampleCount: summary.exampleCount,
            controlMeanScore: summary.control.meanScore,
            candidateMeanScore: summary.candidate.meanScore,
            scoreDelta: summary.scoreDelta,
            recommendation: summary.recommendation,
          },
        });

        // Recommendation-only promotion signal. Audited as a distinct action
        // so an operator can find "the harness suggested promoting X" without
        // implying any mutation actually happened.
        if (summary.recommendation === "promote_candidate") {
          await auditAction(auth, "experiment.run.promotion_suggested", {
            targetType: "experiment",
            targetId: experiment.id,
            metadata: {
              kind,
              controlRef,
              candidateRef,
              scoreDelta: summary.scoreDelta,
              costDelta: summary.costDelta,
              reason: summary.recommendationReason,
            },
          });
        }

        return sendJson(res, { experiment: completed ?? experiment, summary });
      } catch (error) {
        // Unexpected non-model error — flip to failed so the row isn't stuck
        // `running`, then surface a 500-equivalent envelope.
        const failSummary = safePersistPayload({
          error: error instanceof Error ? error.message : String(error),
        }) as Record<string, unknown>;
        await recordExperimentResult(auth.orgId, experiment.id, "failed", failSummary);
        return sendError(res, "experiment_invalid_body", "Experiment run failed", 500);
      }
    },
  },

  // GET /experiments/:id — single experiment metadata + summary.
  {
    method: "GET",
    match: (url) => /^\/experiments\/[^/?]+$/.test(url.split("?")[0] ?? ""),
    role: "viewer",
    permission: "evals.read",
    handler: async ({ req, res, auth }) => {
      const id = experimentIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "id required" }, 400);
      const experiment = await getExperiment(auth.orgId, id);
      if (!experiment) {
        return sendError(res, "experiment_not_found", "Experiment not found", 404);
      }
      return sendJson(res, { experiment });
    },
  },
];
