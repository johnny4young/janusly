/**
 * Experiment runner — the deterministic engine behind the prompt/model
 * comparison harness.
 *
 * Given two RESOLVED arms (control + candidate, each a `{ systemPrompt?,
 * modelHint? }` already flattened by the caller from a prompt version or a
 * model id) and a list of eval examples, it runs every example through
 * BOTH arms via `LlmClient.generateText`, captures per-side `costUsd` /
 * `latencyMs` / `aiError`, scores each side with the configured scorer,
 * and returns an aggregate summary plus a non-binding recommendation.
 *
 * This module is DATA-AGNOSTIC on purpose (`packages/ai` has no
 * `@janusly/data` dependency): the route in `apps/api` resolves prompt
 * refs / model ids into arms and threads the usage-recording side effect
 * in via the `onCall` hook, so the runner stays a pure orchestration over
 * the LLM client + the scorer.
 *
 * Used by:
 *  - `apps/api/src/routes/experiments-routes.ts` — `POST /experiments/run`.
 *
 * Invariants:
 *  - AI fallback contract: a per-side `generateText` throw is CAUGHT and
 *    recorded as `{ aiError }` for that side; the example still scores
 *    (the failed side gets `output: ""`, which the scorer maps to 0). The
 *    run NEVER throws on a model failure.
 *  - Promotion is RECOMMENDATION-ONLY — the summary's `recommendation`
 *    field is advisory; the runner performs NO mutation of prod state.
 *  - `costUsd` may be null (unknown model price). The aggregate treats a
 *    null as "unknown" — it is excluded from the cost sum and the
 *    per-side `costKnown` count reflects how many calls had a price.
 */

import type { LlmClient } from "./llm-client";
import { scoreOutput, type ScorerKind } from "./experiment-scorer";

/** A resolved comparison arm — what one side actually sends to the model. */
export type ExperimentArm = {
  /** Optional flattened system prompt (resolved from a prompt version). */
  systemPrompt?: string;
  /** Optional model override (`"<model>"` or `"<provider>/<model>"`). */
  modelHint?: string;
};

/** The minimal example shape the runner consumes (a projection of `EvalExample`). */
export type ExperimentExample = {
  /** The prompt body the model is asked to answer (the captured input context). */
  input: string;
  /** The gold outcome the scorer measures each side's output against. */
  expected: string;
};

/** Side-effect hook fired once per model call (used to write `usage_events`). */
export type ExperimentCallHook = (call: {
  side: "control" | "candidate";
  exampleIndex: number;
  provider: string;
  model: string;
  costUsd: number | null;
  latencyMs: number;
  aiError: string | null;
}) => void;

/** Per-side aggregate stats. */
export type ExperimentSideSummary = {
  /** Mean score across all examples (failed calls count as 0). */
  meanScore: number;
  /** Total USD across calls with a known price. */
  totalCostUsd: number;
  /** How many calls had a known (non-null) cost. */
  costKnownCount: number;
  /** Mean latency (ms) across all calls (including failed ones). */
  meanLatencyMs: number;
  /** Count of calls that surfaced an `aiError`. */
  errorCount: number;
  /** Count of scorer scores that came from an LLM judge (vs deterministic / fallback). */
  judgedByLlmCount: number;
};

/** The full run summary written to `experiments.summary_json`. */
export type ExperimentSummary = {
  scorerKind: ScorerKind;
  exampleCount: number;
  control: ExperimentSideSummary;
  candidate: ExperimentSideSummary;
  /** Mean-score delta (candidate − control). Positive = candidate scored higher. */
  scoreDelta: number;
  /** Cost delta (candidate − control) over known-cost calls. Negative = candidate cheaper. */
  costDelta: number;
  /**
   * Non-binding recommendation. `promote_candidate` when the candidate's
   * mean score is meaningfully higher (≥ `MIN_SCORE_DELTA`); `keep_control`
   * when control wins or ties; `inconclusive` when the dataset was empty.
   * Cost is NOT a gate — `costDelta` is reported alongside so the operator
   * can weigh it, since "too expensive" is a per-org judgment call.
   */
  recommendation: "promote_candidate" | "keep_control" | "inconclusive";
  /** Plain-language reason for the recommendation (operator-facing). */
  recommendationReason: string;
};

/** Minimum mean-score advantage before the harness suggests promotion. */
export const MIN_SCORE_DELTA = 0.05;

/** Hard cap on examples evaluated in a single run (bounds cost + latency). */
export const MAX_EXAMPLES_PER_RUN = 200;

function emptySide(): {
  scoreSum: number;
  costSum: number;
  costKnown: number;
  latencySum: number;
  errorCount: number;
  judgedCount: number;
} {
  return { scoreSum: 0, costSum: 0, costKnown: 0, latencySum: 0, errorCount: 0, judgedCount: 0 };
}

/**
 * Run one model arm for one example. Wraps the SDK call in try/catch per
 * the AI fallback contract — a throw becomes `{ output: "", aiError }` so
 * the example still scores (the empty output maps to 0).
 */
async function runArm(
  client: LlmClient,
  arm: ExperimentArm,
  input: string,
  context: { orgId: string; userId?: string },
): Promise<{ output: string; provider: string; model: string; costUsd: number | null; latencyMs: number; aiError: string | null }> {
  try {
    const result = await client.generateText({
      system: arm.systemPrompt,
      prompt: input,
      modelHint: arm.modelHint,
      context: { orgId: context.orgId, userId: context.userId },
    });
    return {
      output: result.text,
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd ?? null,
      latencyMs: result.latencyMs,
      aiError: null,
    };
  } catch (error) {
    return {
      output: "",
      provider: arm.modelHint?.includes("/") ? arm.modelHint.split("/")[0]! : "unknown",
      model: arm.modelHint ?? "unknown",
      costUsd: null,
      latencyMs: 0,
      aiError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute the comparison. Iterates examples sequentially (bounded fan-out;
 * a parallel sweep would race the per-org budget and rate limiter), runs
 * both arms, scores each, fires `onCall` per model call for telemetry, and
 * returns the aggregate. NEVER throws on a model-side failure.
 */
export async function runExperiment(input: {
  client: LlmClient | null;
  scorerKind: ScorerKind;
  controlArm: ExperimentArm;
  candidateArm: ExperimentArm;
  examples: readonly ExperimentExample[];
  context: { orgId: string; userId?: string };
  /** Optional model for the LLM judge — defaults to the configured model. */
  judgeModelHint?: string;
  onCall?: ExperimentCallHook;
}): Promise<ExperimentSummary> {
  const examples = input.examples.slice(0, MAX_EXAMPLES_PER_RUN);
  const control = emptySide();
  const candidate = emptySide();

  // A null client means no provider key — every arm "fails" with a
  // deterministic empty output; the scorer still runs (and the judge, if
  // selected, uses its deterministic fallback). The run completes rather
  // than throwing, honoring the AI fallback contract.
  for (let i = 0; i < examples.length; i += 1) {
    const example = examples[i]!;

    const controlRun = input.client
      ? await runArm(input.client, input.controlArm, example.input, input.context)
      : { output: "", provider: "unknown", model: input.controlArm.modelHint ?? "unknown", costUsd: null, latencyMs: 0, aiError: "llm_not_configured" };
    const candidateRun = input.client
      ? await runArm(input.client, input.candidateArm, example.input, input.context)
      : { output: "", provider: "unknown", model: input.candidateArm.modelHint ?? "unknown", costUsd: null, latencyMs: 0, aiError: "llm_not_configured" };

    input.onCall?.({ side: "control", exampleIndex: i, provider: controlRun.provider, model: controlRun.model, costUsd: controlRun.costUsd, latencyMs: controlRun.latencyMs, aiError: controlRun.aiError });
    input.onCall?.({ side: "candidate", exampleIndex: i, provider: candidateRun.provider, model: candidateRun.model, costUsd: candidateRun.costUsd, latencyMs: candidateRun.latencyMs, aiError: candidateRun.aiError });

    const controlScore = await scoreOutput({ scorerKind: input.scorerKind, output: controlRun.output, expected: example.expected, client: input.client, context: input.context, judgeModelHint: input.judgeModelHint });
    const candidateScore = await scoreOutput({ scorerKind: input.scorerKind, output: candidateRun.output, expected: example.expected, client: input.client, context: input.context, judgeModelHint: input.judgeModelHint });

    control.scoreSum += controlScore.score;
    candidate.scoreSum += candidateScore.score;
    if (controlScore.judgedByLlm) control.judgedCount += 1;
    if (candidateScore.judgedByLlm) candidate.judgedCount += 1;

    control.latencySum += controlRun.latencyMs;
    candidate.latencySum += candidateRun.latencyMs;
    if (controlRun.aiError) control.errorCount += 1;
    if (candidateRun.aiError) candidate.errorCount += 1;
    if (controlRun.costUsd !== null) { control.costSum += controlRun.costUsd; control.costKnown += 1; }
    if (candidateRun.costUsd !== null) { candidate.costSum += candidateRun.costUsd; candidate.costKnown += 1; }
  }

  const n = examples.length;
  const controlSummary: ExperimentSideSummary = {
    meanScore: n === 0 ? 0 : control.scoreSum / n,
    totalCostUsd: control.costSum,
    costKnownCount: control.costKnown,
    meanLatencyMs: n === 0 ? 0 : control.latencySum / n,
    errorCount: control.errorCount,
    judgedByLlmCount: control.judgedCount,
  };
  const candidateSummary: ExperimentSideSummary = {
    meanScore: n === 0 ? 0 : candidate.scoreSum / n,
    totalCostUsd: candidate.costSum,
    costKnownCount: candidate.costKnown,
    meanLatencyMs: n === 0 ? 0 : candidate.latencySum / n,
    errorCount: candidate.errorCount,
    judgedByLlmCount: candidate.judgedCount,
  };

  const scoreDelta = candidateSummary.meanScore - controlSummary.meanScore;
  const costDelta = candidateSummary.totalCostUsd - controlSummary.totalCostUsd;

  let recommendation: ExperimentSummary["recommendation"];
  let recommendationReason: string;
  if (n === 0) {
    recommendation = "inconclusive";
    recommendationReason = "The eval dataset has no examples to compare.";
  } else if (scoreDelta >= MIN_SCORE_DELTA) {
    recommendation = "promote_candidate";
    recommendationReason = `Candidate scored ${(scoreDelta * 100).toFixed(1)} points higher on average. Promotion is a suggestion — review and apply manually.`;
  } else {
    recommendation = "keep_control";
    recommendationReason =
      scoreDelta <= -MIN_SCORE_DELTA
        ? `Control scored ${(Math.abs(scoreDelta) * 100).toFixed(1)} points higher on average.`
        : "Scores were within noise; no meaningful improvement from the candidate.";
  }

  return {
    scorerKind: input.scorerKind,
    exampleCount: n,
    control: controlSummary,
    candidate: candidateSummary,
    scoreDelta,
    costDelta,
    recommendation,
    recommendationReason,
  };
}
