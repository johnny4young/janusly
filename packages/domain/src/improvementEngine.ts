/**
 * Improvement engine — confidence math that decides whether a freshly applied
 * workflow change is winning, holding steady, or regressing vs. its baseline.
 *
 * Pure logic, no I/O. The 30%-confidence rollback threshold (per AGENTS.md)
 * is encoded in `shouldRollback`. Persistence and audit happen elsewhere
 * (`packages/data/src/improvementsRepo.ts`, runtime event emission).
 *
 * Used by:
 * - the improvement orchestrator in `packages/engine` — calls
 *   `computeConfidence` after each evaluation cycle and routes to `should*`.
 * - `apps/api/src/index.ts` — surfaces confidence to the Improvements panel.
 */

export type WorkflowMetrics = {
  successRate?: number;
  avgLatencyMs?: number;
  avgCost?: number;
};

export type ImprovementStatus = "improving" | "stable" | "regressing";

export function computeConfidence(before: WorkflowMetrics, after: WorkflowMetrics) {
  const deltaSuccess = (after.successRate ?? 0) - (before.successRate ?? 0);
  const deltaLatency = (before.avgLatencyMs ?? 0) - (after.avgLatencyMs ?? 0);
  const deltaCost = (before.avgCost ?? 0) - (after.avgCost ?? 0);

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
