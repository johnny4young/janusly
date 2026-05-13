/**
 * Type-only contract for the AI cost budget chokepoint.
 *
 * Lives in `@janusly/shared` because both `@janusly/engine` (which owns the
 * `setBudgetChecker` / `checkBudget` runtime) and `@janusly/data` (which
 * implements the production checker) need to agree on the shape WITHOUT
 * either depending on the other. `data → engine` would invert the
 * dependency graph; `engine → data` would pull DB code into the
 * worker's hot path.
 *
 * Zero runtime; type-only.
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
  /** USD cap for the resolved scope. `null` when no budget is configured. */
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
  /** Resolved scope of the active budget. */
  resolvedScope: BudgetCheckScope | null;
};

export type CheckBudgetInput = {
  orgId: string;
  workflowId?: string | null;
  /** Optional predicted cost in USD. Reserved for future ticket; v1 ignores
   *  it and gates on `spent >= limit` only. Kept on the surface so callers
   *  can start threading it through now. */
  predictedCostUsd?: number;
};

export type BudgetChecker = (input: CheckBudgetInput) => Promise<BudgetCheckResult>;
