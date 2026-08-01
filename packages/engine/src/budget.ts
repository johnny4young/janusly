/**
 * AI cost budget chokepoint.
 *
 * Every LLM call site (API routes + engine `ai` node + agent planner) runs
 * `checkBudget({ orgId, workflowId?, predictedCostUsd? })` BEFORE invoking
 * `LlmClient.generateText` / `generateObject`. The check resolves the
 * applicable budget (workflow override → org default → none), sums the
 * current month's `usage_events.metadata.costUsd` for that scope, and
 * returns an envelope describing whether the call may proceed.
 *
 * Used by:
 * - `apps/api/src/routes/ai-routes.ts` — gates all 6 /ai/* routes; throws
 *   `HttpError(402, "budget_exceeded")` when policy is "block".
 * - `packages/engine/src/node-executors/ai.ts` — gates the `ai` node executor;
 *   block path returns `{ mode: "fallback", aiError: "budget_exceeded" }`.
 * - `packages/engine/src/agent-planner.ts` — gates planner LLM calls;
 *   block path emits a "budget_exceeded" terminate decision.
 *
 * Invariants:
 * - Fail-soft on internal errors. When the underlying repo throws (Redis
 *   blip, DB outage), the chokepoint returns `{ allowed: true,
 *   monthlyUsdLimit: null }` so the call proceeds. Matches the
 *   rate-limit fail-open posture — an AI Studio
 *   outage during an infra blip is worse UX than a brief over-budget
 *   window. A `[budget]` warn log fires so operators know we degraded.
 * - The AI fallback contract holds. On a block, callers degrade to
 *   `mode: "fallback"` with `aiError: "budget_exceeded"`; the run
 *   continues to the next node via the existing fallback path. NEVER
 *   throw past this layer unless the caller explicitly wants a hard
 *   stop (the API routes do; the engine paths don't).
 * - Multi-tenant scope. The repo layer enforces it with
 *   `eq(<table>.orgId, orgId)` on every read.
 * - Recorder failures (post-check audit / usage writes) must never
 *   break the call. Callers wrap audit writes in try/catch.
 */

// Type-only re-exports from @janusly/shared so engine consumers can keep
// the existing import paths (`@janusly/engine/src/budget`) while the
// canonical contract lives in the shared package — see the file comment
// in `packages/shared/src/budget-types.ts` for the dep-graph rationale.
export type {
  BudgetPolicy,
  BudgetCheckScope,
  BudgetCheckResult,
  CheckBudgetInput,
  BudgetChecker,
} from "@janusly/shared/src/budget-types";

import type {
  BudgetChecker,
  BudgetCheckResult,
  CheckBudgetInput,
} from "@janusly/shared/src/budget-types";

const FAIL_SOFT_RESULT: BudgetCheckResult = {
  allowed: true,
  monthlyUsdSpent: 0,
  monthlyUsdLimit: null,
  policy: "warn",
  warningPercent: 80,
  warningThresholdCrossed: false,
  exceededAt: null,
  resolvedScope: null,
};

let activeChecker: BudgetChecker | null = null;

/** Wire the production checker at API + worker boot. Tests can override. */
export function setBudgetChecker(checker: BudgetChecker | null): void {
  activeChecker = checker;
}

/** Retrieve the currently registered checker. `null` means no checker is
 *  configured — `checkBudget()` falls back to the fail-soft result so the
 *  call proceeds. */
export function getBudgetChecker(): BudgetChecker | null {
  return activeChecker;
}

/**
 * Run the registered checker. When no checker is wired OR the checker
 * throws, return the fail-soft result (allowed=true, no budget) so the
 * LLM call proceeds. Matches the rate-limit chokepoint's posture.
 */
export async function checkBudget(input: CheckBudgetInput): Promise<BudgetCheckResult> {
  if (!activeChecker) return FAIL_SOFT_RESULT;
  try {
    return await activeChecker(input);
  } catch (err) {
    // Fail-open on internal errors. An infra blip during a budget read must
    // not break a workflow run — the operator would much rather see one
    // extra call slip through than a 500 from /ai/explain-workflow.
    console.warn("[budget] checker threw, failing open", err);
    return FAIL_SOFT_RESULT;
  }
}
