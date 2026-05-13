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
 * - `packages/engine/src/node-registry.ts` — gates the `ai` node executor;
 *   block path returns `{ mode: "fallback", aiError: "budget_exceeded" }`.
 * - `packages/engine/src/agent-planner.ts` — gates planner LLM calls;
 *   block path emits a "budget_exceeded" terminate decision.
 *
 * Invariants:
 * - Fail-soft on internal errors. When the underlying repo throws (Redis
 *   blip, DB outage), the chokepoint returns `{ allowed: true,
 *   monthlyUsdLimit: null }` so the call proceeds. Matches the
 *   rate-limit fail-open posture documented in AGENTS.md — an AI Studio
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

export type BudgetPolicy = "warn" | "block";

export type BudgetCheckScope = "org" | "workflow";

/** Envelope returned by every `checkBudget` call. */
export type BudgetCheckResult = {
  /** True when the call may proceed. False only when policy === "block" AND
   *  the spent amount has crossed the monthly limit. */
  allowed: boolean;
  /** Sum of `usage_events.metadata.costUsd` in the current calendar month,
   *  scoped to the resolved budget (workflow if a per-workflow row exists,
   *  else org). 0 when nothing has been spent. */
  monthlyUsdSpent: number;
  /** USD cap for the resolved scope. `null` when no budget is configured
   *  at either the org or workflow level — `allowed` stays true. */
  monthlyUsdLimit: number | null;
  /** Resolved policy. Workflow row's policy wins over org config; defaults
   *  to "warn" when neither is set. */
  policy: BudgetPolicy;
  /** Warning threshold as a percent of `monthlyUsdLimit` (0-100). */
  warningPercent: number;
  /** True when `monthlyUsdSpent >= monthlyUsdLimit * warningPercent / 100`. */
  warningThresholdCrossed: boolean;
  /** Which scope the budget was resolved at. `null` when no budget set. */
  exceededAt: BudgetCheckScope | null;
  /** Resolved scope of the active budget. Useful for the API envelope so the
   *  web can render "workflow X is over its $10 budget" vs "org over $100". */
  resolvedScope: BudgetCheckScope | null;
};

export type CheckBudgetInput = {
  orgId: string;
  workflowId?: string | null;
  /** Optional predicted cost in USD. Future tickets may use this to gate
   *  preemptively (block if `spent + predicted > limit`); v1 ignores it and
   *  gates on `spent >= limit` only. Kept on the surface so callers can
   *  start threading it through now. */
  predictedCostUsd?: number;
};

export type BudgetChecker = (input: CheckBudgetInput) => Promise<BudgetCheckResult>;

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
