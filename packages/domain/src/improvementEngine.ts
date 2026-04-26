export function computeConfidence(before, after) {
  const deltaSuccess = (after.successRate ?? 0) - (before.successRate ?? 0);
  const deltaLatency = (before.avgLatencyMs ?? 0) - (after.avgLatencyMs ?? 0);
  const deltaCost = (before.avgCost ?? 0) - (after.avgCost ?? 0);

  const score = deltaSuccess * 0.6 + deltaLatency * 0.2 + deltaCost * 0.2;

  const confidence = Math.max(0, Math.min(100, score * 100));

  let status = "stable";
  if (score > 0.1) status = "improving";
  if (score < -0.1) status = "regressing";

  return { confidence, status };
}

export function shouldRollback(confidence) {
  return confidence < 30;
}

export function shouldPromote(confidence) {
  return confidence > 70;
}
