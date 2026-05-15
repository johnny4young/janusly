/**
 * Workflow health score — single 0–100 rollup across six categories
 * (reliability, safety, cost, latency, maintainability, AI risk). Pure
 * aggregator: takes pre-collected signals + the readiness result + the
 * workflow JSON, returns the score with a per-category breakdown.
 *
 * Inputs come from two sources:
 *   - **Static signals** from `checkWorkflowReadiness` (the same engine
 *     module the production-readiness gate uses). These cover safety
 *     posture: retries, http bounds, raw secrets, approval upstream of
 *     write-side actions, missing outputs.
 *   - **Run-time signals** collected from `runs` / `run_events` /
 *     `dead_letters` / `usage_events` over a rolling window
 *     (`packages/data/src/workflowHealthRepo.ts`). These cover reliability
 *     (success rate, DLQ count, retry count), cost (USD per run, total
 *     tokens), and latency (p95 across runs).
 *
 * Used by:
 *   - `apps/api/src/index.ts:GET /workflows/health` — returns the score
 *     for one workflow id; renders into the web's health badge.
 *   - `packages/data/src/workflowHealthRepo.ts` returns the same
 *     `HealthSignals` shape via structural typing, without importing
 *     from engine.
 *
 * Adding a new category: extend `HealthCategory`, the `BREAKDOWN_WEIGHTS`
 * record, and `HealthBreakdown`. Make sure the weights still sum to 1.0
 * (the test pin asserts this). Issue codes used for rationale strings
 * are operator-facing, not localised — keep them readable.
 *
 * The constants block (weights, bands, neutral defaults) is exported so
 * tests can pin behaviour without re-encoding magic numbers, and so
 * future tuning is one place to look.
 */

import type { Workflow } from "@janusly/shared";
import type { ReadinessResult } from "./workflow-readiness";

/** Six categories the score rolls up. */
export type HealthCategory =
  | "reliability"
  | "safety"
  | "cost"
  | "latency"
  | "maintainability"
  | "aiRisk";

export type HealthRationaleCode =
  | "reliability.no_runs"
  | "reliability.summary"
  | "safety.clean"
  | "safety.summary"
  | "latency.insufficient"
  | "latency.summary"
  | "cost.none"
  | "cost.summary"
  | "maintainability.summary"
  | "ai_risk.no_ai"
  | "ai_risk.summary";

/** Per-category sub-score + human-readable rationale. */
export type HealthBreakdownEntry = {
  /** Sub-score, 0–100 integer. */
  score: number;
  /** Single-sentence operator-facing explanation. */
  rationale: string;
  /** Stable client-localisable rationale code. */
  rationaleCode: HealthRationaleCode;
  /** Structured interpolation data for `rationaleCode`. */
  rationaleMeta?: Record<string, string | number | boolean>;
};

export type HealthBreakdown = Record<HealthCategory, HealthBreakdownEntry>;

/** Top-level rollup — `healthy` ≥ 80, `warn` ≥ 60, `unhealthy` < 60. */
export type HealthStatus = "healthy" | "warn" | "unhealthy";

/** The full score response, including the input signals echoed back so
 *  UI surfaces can display "27 / 30 successful runs" without re-querying. */
export type HealthScore = {
  /** Overall, 0–100 integer (weighted average of the six categories). */
  score: number;
  status: HealthStatus;
  breakdown: HealthBreakdown;
  signals: HealthSignals;
};

/** Run-time signals collected from the persistence layer. The data repo
 *  defines the same shape locally to keep package dependencies one-way;
 *  treat this as the wire contract between the API route and the repo. */
export type HealthSignals = {
  /** Number of runs in the window for this workflow. */
  totalRuns: number;
  /** Subset of `totalRuns` whose terminal status was `succeeded`. */
  successCount: number;
  /** Subset of `totalRuns` whose terminal status was `failed`. */
  failureCount: number;
  /** Sum of `node.retry` events across all runs in the window. */
  retryCount: number;
  /** Count of `dead_letters` rows with `status: "open"` for runs in the window. */
  dlqOpenCount: number;
  /** p95 of `runs.createdAt → terminal-status` durations in ms. `null` when fewer than 5 runs. */
  p95LatencyMs: number | null;
  /** Sum of `usage_events.metadata.costUsd` across runs in the window. Dollars. */
  totalCostUsd: number;
  /** Sum of `usage_events.quantity` across runs in the window (tokens for LLM metrics). */
  totalTokens: number;
  /** Number of distinct `workflow_versions` rows. ≥2 means rollback target available. */
  versionCount: number;
};

// --- Constants (exported for test pinning) -------------------------------------

/** Weights sum to 1.0 — pinned by `health-weights-sum-to-one` test. Tweak only with full rebalancing. */
export const BREAKDOWN_WEIGHTS: Record<HealthCategory, number> = {
  reliability: 0.30,
  safety: 0.25,
  latency: 0.15,
  cost: 0.10,
  maintainability: 0.10,
  aiRisk: 0.10,
};

/** When a category has no signal (zero runs, no AI nodes, …) we land on
 *  this neutral score rather than penalising. A never-run workflow is
 *  untested, not unhealthy. */
export const NEUTRAL_DEFAULT = 80;

/** Status thresholds. Tweak only with care — operator UI maps colour to status. */
export const STATUS_THRESHOLDS = { healthy: 80, warn: 60 } as const;

/** Reliability formula bands. */
export const RELIABILITY_DLQ_PENALTY_PER_ROW = 5;
export const RELIABILITY_DLQ_PENALTY_CAP = 30;
export const RELIABILITY_RETRY_PENALTY_FACTOR = 20;
export const RELIABILITY_RETRY_PENALTY_CAP = 20;

/** Safety formula. */
export const SAFETY_FAIL_PENALTY = 20;
export const SAFETY_WARN_PENALTY = 5;

/** Cost band. */
export const COST_BAND_LOW_USD_PER_RUN = 0.01;
export const COST_BAND_HIGH_USD_PER_RUN = 1.0;
export const COST_BAND_LOW_SCORE = 100;
export const COST_BAND_HIGH_SCORE = 30;

/** Latency band (ms). */
export const LATENCY_BAND_LOW_MS = 5_000;
export const LATENCY_BAND_HIGH_MS = 60_000;
export const LATENCY_BAND_LOW_SCORE = 100;
export const LATENCY_BAND_HIGH_SCORE = 30;

/** Maintainability constants. */
export const MAINTAINABILITY_OUTPUTS_BONUS = 50;
export const MAINTAINABILITY_NO_OUTPUTS_BASE = 30;
export const MAINTAINABILITY_VERSION_BONUS = 30;
export const MAINTAINABILITY_NO_VERSIONS_BASE = 10;
export const MAINTAINABILITY_APPROVAL_BONUS = 20;
export const MAINTAINABILITY_NO_APPROVAL_BASE = 10;

/** AI risk constants. */
export const AIRISK_AI_NODE_PENALTY = 5;
export const AIRISK_TOKEN_PENALTY_PER_100K = 1;
export const AIRISK_RAW_SECRET_PENALTY = 30;

/**
 * Minimum number of post-Apply runs required before the recovery
 * before/after delta surfaces a meaningful health-score comparison. Below
 * this threshold the delta route returns `hasEnoughData: false` and the
 * dialog renders the run counter + same-failure pills instead of the
 * full delta. Pinned here so the dialog and the route agree.
 */
export const MIN_RUNS_FOR_DELTA = 5;

// --- Aggregator ---------------------------------------------------------------

/** Compute the weighted health score + breakdown. Pure — no I/O. */
export function computeWorkflowHealth(input: {
  workflow: Workflow;
  readiness: ReadinessResult;
  signals: HealthSignals;
}): HealthScore {
  const { workflow, readiness, signals } = input;

  const reliability = computeReliability(signals);
  const safety = computeSafety(readiness);
  const latency = computeLatency(signals);
  const cost = computeCost(signals);
  const maintainability = computeMaintainability(workflow, readiness, signals);
  const aiRisk = computeAiRisk(workflow, readiness, signals);

  const breakdown: HealthBreakdown = {
    reliability,
    safety,
    latency,
    cost,
    maintainability,
    aiRisk,
  };

  const overall = Math.round(
    breakdown.reliability.score * BREAKDOWN_WEIGHTS.reliability +
    breakdown.safety.score * BREAKDOWN_WEIGHTS.safety +
    breakdown.latency.score * BREAKDOWN_WEIGHTS.latency +
    breakdown.cost.score * BREAKDOWN_WEIGHTS.cost +
    breakdown.maintainability.score * BREAKDOWN_WEIGHTS.maintainability +
    breakdown.aiRisk.score * BREAKDOWN_WEIGHTS.aiRisk,
  );

  return {
    score: overall,
    status: rollupStatus(overall),
    breakdown,
    signals,
  };
}

function rollupStatus(score: number): HealthStatus {
  if (score >= STATUS_THRESHOLDS.healthy) return "healthy";
  if (score >= STATUS_THRESHOLDS.warn) return "warn";
  return "unhealthy";
}

function computeReliability(signals: HealthSignals): HealthBreakdownEntry {
  if (signals.totalRuns === 0) {
    return {
      score: NEUTRAL_DEFAULT,
      rationale: "No runs yet — neutral score until execution data accrues.",
      rationaleCode: "reliability.no_runs",
    };
  }
  const successRate = signals.successCount / signals.totalRuns;
  const successScore = successRate * 100;
  const dlqPenalty = Math.min(signals.dlqOpenCount * RELIABILITY_DLQ_PENALTY_PER_ROW, RELIABILITY_DLQ_PENALTY_CAP);
  const retryRate = signals.retryCount / signals.totalRuns;
  const retryPenalty = Math.min(retryRate * RELIABILITY_RETRY_PENALTY_FACTOR, RELIABILITY_RETRY_PENALTY_CAP);
  const score = Math.max(0, Math.round(successScore - dlqPenalty - retryPenalty));
  return {
    score,
    rationale: `${signals.successCount}/${signals.totalRuns} runs succeeded; ${signals.dlqOpenCount} open dead letters; ${signals.retryCount} retry events.`,
    rationaleCode: "reliability.summary",
    rationaleMeta: {
      successCount: signals.successCount,
      totalRuns: signals.totalRuns,
      dlqOpenCount: signals.dlqOpenCount,
      retryCount: signals.retryCount,
    },
  };
}

function computeSafety(readiness: ReadinessResult): HealthBreakdownEntry {
  const failCount = readiness.issues.filter((issue) => issue.severity === "fail").length;
  const warnCount = readiness.issues.filter((issue) => issue.severity === "warn").length;
  const score = Math.max(0, 100 - failCount * SAFETY_FAIL_PENALTY - warnCount * SAFETY_WARN_PENALTY);
  if (failCount === 0 && warnCount === 0) {
    return {
      score: 100,
      rationale: "Readiness checks pass — no production-posture issues.",
      rationaleCode: "safety.clean",
    };
  }
  return {
    score,
    rationale: `${failCount} blocking + ${warnCount} warning readiness finding${failCount + warnCount === 1 ? "" : "s"} (retries, bounds, secrets, approvals, outputs).`,
    rationaleCode: "safety.summary",
    rationaleMeta: { failCount, warnCount },
  };
}

function computeLatency(signals: HealthSignals): HealthBreakdownEntry {
  if (signals.p95LatencyMs === null) {
    return {
      score: NEUTRAL_DEFAULT,
      rationale: "Insufficient runs to compute p95 latency — neutral score.",
      rationaleCode: "latency.insufficient",
    };
  }
  const score = bandScore(
    signals.p95LatencyMs,
    LATENCY_BAND_LOW_MS,
    LATENCY_BAND_HIGH_MS,
    LATENCY_BAND_LOW_SCORE,
    LATENCY_BAND_HIGH_SCORE,
  );
  return {
    score,
    rationale: `p95 run duration ${(signals.p95LatencyMs / 1000).toFixed(1)}s across ${signals.totalRuns} runs.`,
    rationaleCode: "latency.summary",
    rationaleMeta: { seconds: (signals.p95LatencyMs / 1000).toFixed(1), totalRuns: signals.totalRuns },
  };
}

function computeCost(signals: HealthSignals): HealthBreakdownEntry {
  if (signals.totalRuns === 0 || signals.totalCostUsd === 0) {
    return {
      score: NEUTRAL_DEFAULT,
      rationale: "No usage cost recorded yet — neutral score.",
      rationaleCode: "cost.none",
    };
  }
  const costPerRun = signals.totalCostUsd / signals.totalRuns;
  const score = bandScore(
    costPerRun,
    COST_BAND_LOW_USD_PER_RUN,
    COST_BAND_HIGH_USD_PER_RUN,
    COST_BAND_LOW_SCORE,
    COST_BAND_HIGH_SCORE,
  );
  return {
    score,
    rationale: `$${costPerRun.toFixed(4)} per run (${signals.totalCostUsd.toFixed(2)} total across ${signals.totalRuns} runs).`,
    rationaleCode: "cost.summary",
    rationaleMeta: {
      costPerRun: costPerRun.toFixed(4),
      totalCostUsd: signals.totalCostUsd.toFixed(2),
      totalRuns: signals.totalRuns,
    },
  };
}

function computeMaintainability(workflow: Workflow, readiness: ReadinessResult, signals: HealthSignals): HealthBreakdownEntry {
  const hasOutputs = !readiness.issues.some((issue) => issue.code === "workflow_missing_outputs");
  const hasMultipleVersions = signals.versionCount >= 2;
  const hasApprovalNode = workflow.nodes.some((node) => node.type === "approval");
  const score = Math.min(
    100,
    (hasOutputs ? MAINTAINABILITY_OUTPUTS_BONUS : MAINTAINABILITY_NO_OUTPUTS_BASE) +
      (hasMultipleVersions ? MAINTAINABILITY_VERSION_BONUS : MAINTAINABILITY_NO_VERSIONS_BASE) +
      (hasApprovalNode ? MAINTAINABILITY_APPROVAL_BONUS : MAINTAINABILITY_NO_APPROVAL_BASE),
  );
  const parts: string[] = [];
  parts.push(hasOutputs ? "outputs declared" : "no outputs");
  parts.push(hasMultipleVersions ? `${signals.versionCount} versions` : "single version (no rollback target)");
  parts.push(hasApprovalNode ? "approval node present" : "no human gate");
  return {
    score,
    rationale: parts.join("; ") + ".",
    rationaleCode: "maintainability.summary",
    rationaleMeta: {
      hasOutputs,
      hasMultipleVersions,
      versionCount: signals.versionCount,
      hasApprovalNode,
    },
  };
}

function computeAiRisk(workflow: Workflow, readiness: ReadinessResult, signals: HealthSignals): HealthBreakdownEntry {
  const aiNodeCount = workflow.nodes.filter((node) => node.type === "ai" || node.type === "agent" || node.type === "multi_agent").length;
  if (aiNodeCount === 0) {
    return {
      score: 100,
      rationale: "No AI / agent nodes — no AI risk surface.",
      rationaleCode: "ai_risk.no_ai",
    };
  }
  const rawSecretCount = readiness.issues.filter((issue) => issue.code === "raw_secret_in_config").length;
  const score = Math.max(
    0,
    Math.round(
      100 -
        aiNodeCount * AIRISK_AI_NODE_PENALTY -
        (signals.totalTokens / 100_000) * AIRISK_TOKEN_PENALTY_PER_100K -
        rawSecretCount * AIRISK_RAW_SECRET_PENALTY,
    ),
  );
  return {
    score,
    rationale: `${aiNodeCount} AI/agent node${aiNodeCount === 1 ? "" : "s"}; ${signals.totalTokens.toLocaleString()} tokens consumed; ${rawSecretCount} hardcoded-secret finding${rawSecretCount === 1 ? "" : "s"}.`,
    rationaleCode: "ai_risk.summary",
    rationaleMeta: {
      aiNodeCount,
      totalTokens: signals.totalTokens,
      rawSecretCount,
    },
  };
}

/** Linear interpolation between two band points, clamped at the edges. */
function bandScore(value: number, lowInput: number, highInput: number, lowScore: number, highScore: number): number {
  if (value <= lowInput) return lowScore;
  if (value >= highInput) return highScore;
  const t = (value - lowInput) / (highInput - lowInput);
  return Math.round(lowScore + t * (highScore - lowScore));
}
