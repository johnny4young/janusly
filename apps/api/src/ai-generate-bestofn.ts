/**
 * Best-of-N candidate generation + selection for `/ai/generate-workflow`.
 *
 * Free-JSON generation has real per-prompt variance — the same prompt can
 * yield a clean workflow on one sample and a weaker one on the next. Instead
 * of trusting a single sample, this module fires N independent samples and
 * keeps the best by a CHEAP DETERMINISTIC score (`checkWorkflowReadiness`),
 * not a second LLM judge. The winner is then handed back to the route's
 * existing Pass-2 promote → sanitize → repair → fallback tail unchanged, so
 * the AI-fallback contract and self-repair behavior are preserved.
 *
 * Cost: N (1–5) extra `generateText` calls only when Best-of-N is opted into
 * (`org_configs.ai.generationCandidates > 1`; default 1 = single-shot, the
 * pre-existing behavior). Each call records a `usage_events` row via the
 * LLM-client chokepoint, same as any other generation call.
 *
 * Used by `apps/api/src/routes/ai-routes.ts` (the free_json generation branch).
 */

import { type LlmClient } from "@janusly/ai";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { type Workflow } from "@janusly/shared";

import { parseGeneratedWorkflow } from "./ai-generate-freejson";
import { sanitizeAiWorkflow } from "./ai-runtime";

/** Inclusive bounds for the configured candidate count (`ai.generationCandidates`). */
export const MIN_GENERATION_CANDIDATES = 1;
export const MAX_GENERATION_CANDIDATES = 5;

/**
 * One successfully-parsed Best-of-N candidate. `model` / `provider` are carried
 * from the sample that produced it so the route can attribute the winner in the
 * `ai.workflow.generated` audit row. The `workflow` is the RAW parsed draft
 * (pre-promotion) — the route promotes + sanitizes it exactly as it does the
 * single-shot Pass-1 draft.
 */
export type GeneratedCandidate = {
  workflow: Workflow;
  model: string;
  provider: string;
};

/**
 * Result of picking the best candidate. `validCount` is how many candidates
 * passed the strict `sanitizeAiWorkflow` validity gate (0 means the `winner`
 * is a best-effort pick that still needs the route's repair pass).
 */
export type CandidateSelection = {
  winner: GeneratedCandidate;
  validCount: number;
};

function clampCandidateCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_GENERATION_CANDIDATES;
  return Math.max(MIN_GENERATION_CANDIDATES, Math.min(MAX_GENERATION_CANDIDATES, Math.trunc(n)));
}

/**
 * Fire `n` (clamped to [1,5]) independent free-JSON generations in parallel and
 * return the ones that parsed into a `Workflow`. One sample per candidate — the
 * diversity across N replaces the single-path retry-on-parse-fail. A rejected
 * SDK call or an unparseable reply is dropped (never throws): the caller treats
 * an empty result as "fall back to the single-shot retry path".
 */
export async function generateWorkflowCandidates(
  llm: LlmClient,
  system: string,
  prompt: string,
  modelHint: string | undefined,
  context: { orgId: string; userId?: string },
  n: number,
  cacheSystemPrompt = false,
): Promise<GeneratedCandidate[]> {
  const count = clampCandidateCount(n);
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () =>
      llm.generateText({ system, prompt, responseFormat: "json", modelHint, cacheSystemPrompt, context }),
    ),
  );

  const candidates: GeneratedCandidate[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const workflow = parseGeneratedWorkflow(outcome.value.text ?? "");
    if (workflow) {
      candidates.push({ workflow, model: outcome.value.model, provider: outcome.value.provider });
    }
  }
  return candidates;
}

/**
 * Pick the best candidate by a deterministic, $0 readiness score (NOT an LLM
 * judge). A candidate is "valid" when it passes the strict
 * `sanitizeAiWorkflow` graph gate; among valid candidates the one with the
 * fewest readiness issues wins (a `fail` weighs 10× a `warn`). When none
 * validate, the first parsed candidate is returned as a best-effort winner so
 * the route's promote → sanitize → repair tail still gets a chance to fix it.
 * Returns `null` only when the candidate list is empty.
 */
export function selectBestCandidate(candidates: GeneratedCandidate[]): CandidateSelection | null {
  if (candidates.length === 0) return null;

  let best: { candidate: GeneratedCandidate; score: number } | null = null;
  let validCount = 0;

  for (const candidate of candidates) {
    let sanitized: Workflow;
    try {
      sanitized = sanitizeAiWorkflow(candidate.workflow);
    } catch {
      continue; // not a structurally valid graph — skip for scoring
    }
    validCount++;
    const issues = checkWorkflowReadiness(sanitized).issues;
    const fails = issues.filter((issue) => issue.severity === "fail").length;
    const warns = issues.filter((issue) => issue.severity === "warn").length;
    const score = fails * 10 + warns; // lower is better
    if (best === null || score < best.score) {
      best = { candidate, score };
    }
  }

  // No candidate passed the validity gate → best-effort: hand the first parsed
  // draft to the route's repair pass rather than discarding straight to fallback.
  const winner = best ? best.candidate : candidates[0]!;
  return { winner, validCount };
}
