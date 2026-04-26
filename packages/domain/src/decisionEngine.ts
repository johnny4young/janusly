export async function decide({ orgId, candidates, preferences, budget }) {
  const wc = (preferences?.weightCost ?? 40) / 100;
  const wl = (preferences?.weightLatency ?? 40) / 100;
  const wq = (preferences?.weightQuality ?? 20) / 100;

  let scored = candidates.map((n) => {
    const cost = n.avgCost ?? 0;
    const latency = n.avgLatencyMs ?? 0;
    const quality = n.successRate ?? 0;

    const score = wc * cost + wl * latency + wq * (1 - quality);

    return {
      nodeId: n.nodeId,
      score,
      breakdown: { cost, latency, quality }
    };
  });

  if (budget?.limitUsd) {
    scored = scored.filter((n) => n.breakdown.cost <= budget.limitUsd);
  }

  scored.sort((a, b) => a.score - b.score);

  const best = scored[0];

  return {
    chosenNodeId: best?.nodeId,
    reason: `cost=${best?.breakdown.cost}, latency=${best?.breakdown.latency}`,
    confidence: Math.max(0.5, 1 - (best?.score ?? 0)),
    ranking: scored
  };
}
