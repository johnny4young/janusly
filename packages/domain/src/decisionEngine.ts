/**
 * Decision engine — scores routing candidates against (cost, latency, quality)
 * preferences within a budget, then applies any RL adjustments before
 * returning a ranked list.
 *
 * Pure logic, no I/O. Called from `packages/engine/src/core/runtime.ts` when
 * a `router` node fires — the engine fetches candidate stats from
 * `packages/data/src/routingStatsRepo.ts` and feeds them in.
 *
 * Invariants:
 * - `scoreCandidate` is deterministic — same inputs always yield the same
 *   score. Useful for `replayDecision` in `causalReasoning.ts`.
 * - `decide` returns a *ranked* list, not just the winner; consumers can
 *   show alternatives in the UI.
 */

import { applyRlAdjustments, type RlStats } from "./reinforcement";

export type DecisionCandidate = {
  nodeId: string;
  avgCost?: number;
  avgLatencyMs?: number;
  successRate?: number;
  metadata?: unknown;
};

export type DecisionPreferences = {
  weightCost?: number;
  weightLatency?: number;
  weightQuality?: number;
  minSuccessRate?: number;
  maxLatencyMs?: number;
};

export type DecisionBudget = {
  limitUsd?: number;
};

export type DecisionInput = {
  orgId?: string;
  candidates: DecisionCandidate[];
  preferences?: DecisionPreferences;
  budget?: DecisionBudget;
  rlStats?: Record<string, RlStats>;
  strategy?: "auto" | "cheapest" | "fastest" | "balanced";
};

export type RankedDecisionCandidate = {
  nodeId: string;
  score: number;
  breakdown: {
    cost: number;
    latency: number;
    quality: number;
    penalty: number;
  };
};

export type DecisionOutput = {
  chosenNodeId?: string;
  reason: string;
  confidence: number;
  ranking: RankedDecisionCandidate[];
};

function normalizedWeights(preferences?: DecisionPreferences) {
  const cost = preferences?.weightCost ?? 40;
  const latency = preferences?.weightLatency ?? 40;
  const quality = preferences?.weightQuality ?? 20;
  const total = cost + latency + quality || 1;

  return {
    cost: cost / total,
    latency: latency / total,
    quality: quality / total,
  };
}

function applyConstraints(
  candidates: DecisionCandidate[],
  preferences?: DecisionPreferences,
) {
  return candidates.filter((candidate) => {
    if (preferences?.minSuccessRate !== undefined) {
      const threshold =
        preferences.minSuccessRate > 1
          ? preferences.minSuccessRate / 100
          : preferences.minSuccessRate;
      if ((candidate.successRate ?? 0) < threshold) return false;
    }

    if (
      preferences?.maxLatencyMs !== undefined &&
      (candidate.avgLatencyMs ?? 0) > preferences.maxLatencyMs
    ) {
      return false;
    }

    return true;
  });
}

export function scoreCandidate(
  candidate: DecisionCandidate,
  preferences?: DecisionPreferences,
) {
  const weights = normalizedWeights(preferences);
  const cost = candidate.avgCost ?? 0;
  const latency = candidate.avgLatencyMs ?? 0;
  const quality = candidate.successRate ?? 0;
  const penalty = 1 - quality;

  return {
    nodeId: candidate.nodeId,
    score:
      weights.cost * cost +
      weights.latency * latency +
      weights.quality * penalty,
    breakdown: { cost, latency, quality, penalty },
  } satisfies RankedDecisionCandidate;
}

export async function decide(input: DecisionInput): Promise<DecisionOutput> {
  const constrained = applyConstraints(input.candidates, input.preferences);
  const candidatePool = constrained.length ? constrained : input.candidates;
  let scored = candidatePool.map((candidate) =>
    scoreCandidate(candidate, input.preferences),
  );
  // Bias scores by historical reinforcement counters before ranking.
  scored = applyRlAdjustments(scored, input.rlStats, {
    enabled: true,
    influence: 0.1,
  });

  if (input.strategy === "cheapest") {
    scored = scored.sort((a, b) => a.breakdown.cost - b.breakdown.cost);
  } else if (input.strategy === "fastest") {
    scored = scored.sort((a, b) => a.breakdown.latency - b.breakdown.latency);
  } else {
    scored = scored.sort((a, b) => a.score - b.score);
  }

  if (input.budget?.limitUsd !== undefined) {
    const budgetSafe = scored.filter(
      (candidate) => candidate.breakdown.cost <= input.budget!.limitUsd!,
    );
    if (budgetSafe.length) scored = budgetSafe;
  }

  const best = scored[0];

  return {
    chosenNodeId: best?.nodeId,
    reason: best
      ? `Selected ${best.nodeId} using ${input.strategy ?? "auto"} strategy: cost=${best.breakdown.cost}, latency=${best.breakdown.latency}, quality=${best.breakdown.quality}`
      : "No eligible candidate found",
    confidence: best ? Math.max(0.5, Math.min(1, 1 - best.score)) : 0,
    ranking: scored,
  };
}
