/**
 * RL adjustments + reward computation — biases candidate scores by their
 * historical reinforcement counters (`pulls`, `meanReward`,
 * success/failure counts) and computes the reward signal each completed
 * decision feeds back.
 *
 * Pure logic, no I/O. The `routing_stats` row provides the inputs; the
 * runtime applies the output before picking a winner. Today's adjustments
 * are intentionally a small counter-based heuristic; a future policy layer
 * can replace this with UCB / Thompson sampling without changing the repo
 * contract.
 *
 * Used by `packages/domain/src/decisionEngine.ts` and the runtime's
 * post-routing reward update path.
 */

export type RlStats = {
  nodeId: string;
  pulls?: number;
  meanReward?: number;
  successCount?: number;
  failureCount?: number;
};

export type RlAdjustmentOptions = {
  enabled?: boolean;
  influence?: number;
  minPulls?: number;
};

export function applyRlAdjustments<T extends { nodeId: string; score: number }>(
  ranked: T[],
  stats: Record<string, RlStats> = {},
  options: RlAdjustmentOptions = {},
): T[] {
  if (options.enabled === false) return ranked;

  const influence = options.influence ?? 0.1;
  const minPulls = options.minPulls ?? 3;

  return ranked
    .map((candidate) => {
      const stat = stats[candidate.nodeId];
      if (!stat || (stat.pulls ?? 0) < minPulls) return candidate;

      const meanReward = stat.meanReward ?? 0;
      return {
        ...candidate,
        score: candidate.score - meanReward * influence,
      };
    })
    .sort((a, b) => a.score - b.score);
}

export function computePreferenceReward(
  result: { success: boolean; latencyMs?: number; cost?: number },
  preferences?: { weightCost?: number; weightLatency?: number; weightQuality?: number },
) {
  const costWeight = (preferences?.weightCost ?? 40) / 100;
  const latencyWeight = (preferences?.weightLatency ?? 40) / 100;
  const qualityWeight = (preferences?.weightQuality ?? 20) / 100;

  const successReward = result.success ? 1 : -1;
  const latencyPenalty = -Math.min((result.latencyMs ?? 0) / 5000, 1);
  const costPenalty = -Math.min((result.cost ?? 0) / 0.01, 1);

  return qualityWeight * successReward + latencyWeight * latencyPenalty + costWeight * costPenalty;
}
