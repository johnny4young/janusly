/**
 * Improvement engine — confidence math that decides whether a freshly applied
 * workflow change is winning, holding steady, or regressing vs. its baseline.
 *
 * Pure logic, no I/O. The 30%-confidence rollback threshold is encoded in
 * `shouldRollback`. Persistence and audit happen elsewhere
 * (`packages/data/src/improvementsRepo.ts`, runtime event emission).
 *
 * Used by:
 * - `packages/engine/src/core/runtime.ts` — calls `computeConfidence` after
 *   an evaluated node completes and routes to `should*`.
 * - future API/read models can use the same pure helpers when surfacing
 *   improvement confidence; today's route registry does not own a dedicated
 *   improvements endpoint.
 */

export type WorkflowMetrics = {
  successRate?: number;
  avgLatencyMs?: number;
  avgCost?: number;
};

export type ImprovementStatus = "improving" | "stable" | "regressing";

export function computeConfidence(before: WorkflowMetrics, after: WorkflowMetrics) {
  // All three deltas are normalized to the SAME scale — a signed fractional
  // improvement — before the weighted blend. `successRate` is already a
  // fraction, so its delta is used directly. Latency and cost are absolute
  // (ms / dollars), so their deltas are expressed RELATIVE to the baseline;
  // otherwise raw millisecond swings would dwarf the success signal and the
  // 0.6 / 0.2 / 0.2 weights would be meaningless. A zero (or missing)
  // baseline contributes 0 — no improvement can be measured against nothing.
  const deltaSuccess = (after.successRate ?? 0) - (before.successRate ?? 0);
  const beforeLatency = before.avgLatencyMs ?? 0;
  const beforeCost = before.avgCost ?? 0;
  const deltaLatency = beforeLatency > 0 ? (beforeLatency - (after.avgLatencyMs ?? 0)) / beforeLatency : 0;
  const deltaCost = beforeCost > 0 ? (beforeCost - (after.avgCost ?? 0)) / beforeCost : 0;

  const score = deltaSuccess * 0.6 + deltaLatency * 0.2 + deltaCost * 0.2;

  const confidence = Math.max(0, Math.min(100, score * 100));

  let status: ImprovementStatus = "stable";
  if (score > 0.1) status = "improving";
  if (score < -0.1) status = "regressing";

  return { confidence, status };
}

export function shouldRollback(confidence: number) {
  return confidence < 30;
}

export function shouldPromote(confidence: number) {
  return confidence > 70;
}
