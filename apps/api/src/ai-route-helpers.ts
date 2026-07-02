/**
 * Shared helpers for the split `/ai/*` route modules.
 *
 * `withBudgetWarning` is the single chokepoint every AI surface uses to
 * attach the cost-governance envelope to a response ONLY when the org has
 * crossed its monthly warning threshold — so the AI-fallback contract
 * (`{ mode, aiError, ... }`) stays byte-for-byte identical below the
 * threshold and gains a `budget` block above it. Lives here (not in any
 * single route module) because generate / explain / review / patch /
 * improve / explain-run all call it.
 */
import { attachBudgetEnvelope, type GateBudgetOutcome } from "./budget-gate";

export function withBudgetWarning<T extends Record<string, unknown>>(response: T, budgetGate: GateBudgetOutcome): T {
  return budgetGate.envelope.warningThresholdCrossed
    ? attachBudgetEnvelope(response, budgetGate.envelope)
    : response;
}
