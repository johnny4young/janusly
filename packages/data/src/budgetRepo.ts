/**
 * Production budget composer — reads the configured org + workflow budgets,
 * sums the current-month AI spend from `usage_events.metadata.costUsd`, and
 * returns the `BudgetCheckResult` envelope the chokepoint (`checkBudget` in
 * `packages/engine/src/budget.ts`) expects.
 *
 * Resolution order:
 *   1. If `workflow_budgets` row exists for `(orgId, workflowId)` → workflow
 *      limit + policy win, and the monthly spend is summed scoped to
 *      `metadata.workflowId = workflowId`.
 *   2. Else if `org_configs.ai.budgetMonthlyUsd > 0` → org limit wins, and
 *      the monthly spend is summed org-wide across every LLM call.
 *   3. Else no budget configured → `allowed=true`, `monthlyUsdLimit=null`,
 *      `exceededAt=null` (the gate is effectively a no-op).
 *
 * Wired at api + worker boot via `setBudgetChecker(productionBudgetChecker)`.
 *
 * Used by:
 * - `apps/api/src/index.ts` — registers the checker at boot.
 * - `packages/engine/src/worker.ts` — same.
 *
 * Invariants:
 * - Every read is org-scoped via `eq(<table>.orgId, orgId)`.
 * - Fail-soft on internal errors: a DB throw on the usage sum returns
 *   `null` (no spend known) so the gate stays open. The outer `checkBudget`
 *   wrapper additionally fails open on any throw. Matches the rate-limit
 *   chokepoint's posture documented in AGENTS.md.
 * - Recorder failures (audit / usage writes) are caught by the callers and
 *   never break the workflow run.
 */

import { and, eq, gte, sql } from "drizzle-orm";

import { db, usageEvents } from "@janusly/db";
import type { BudgetCheckResult, BudgetChecker, BudgetPolicy } from "@janusly/shared/src/budget-types";

import { listOrgConfig } from "./orgConfigRepo";
import { getWorkflowBudget, type WorkflowBudgetRow } from "./workflowBudgetsRepo";

const DEFAULT_WARN_PERCENT = 80;
const DEFAULT_POLICY: BudgetPolicy = "warn";

/** Sum `metadata.costUsd` for `usage_events` in the current calendar month.
 *  Returns `null` when the query throws (fail-soft inner layer). */
async function sumMonthlyAiCostUsd(args: {
  orgId: string;
  workflowId?: string | null;
}): Promise<number | null> {
  try {
    const start = startOfMonth(new Date());
    // Read rows over the closed window then sum in JS — keeps the query
    // plan identical to other usage queries (no jsonb-path arithmetic in
    // SQL). The window is bounded by the calendar month, which is small
    // even for noisy orgs, and capped at 10k rows defensively.
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(
        eq(usageEvents.orgId, args.orgId),
        gte(usageEvents.createdAt, start),
        eq(usageEvents.metric, "llm.completion"),
        ...(args.workflowId
          ? [sql`${usageEvents.metadata} ->> 'workflowId' = ${args.workflowId}`]
          : []),
      ))
      .limit(10_000);

    let total = 0;
    for (const row of rows) {
      const metadata = row.metadata as { costUsd?: unknown } | null;
      const cost = metadata && typeof metadata === "object" ? metadata.costUsd : undefined;
      if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
    }
    return total;
  } catch (err) {
    console.warn("[budget] usage sum failed, returning null", err);
    return null;
  }
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

type ResolvedBudget = {
  monthlyUsdLimit: number | null;
  warningPercent: number;
  policy: BudgetPolicy;
  scope: "org" | "workflow" | null;
};

async function resolveBudget(args: {
  orgId: string;
  workflowId?: string | null;
}): Promise<ResolvedBudget> {
  const workflowRow: WorkflowBudgetRow | null = args.workflowId
    ? await getWorkflowBudget(args.orgId, args.workflowId).catch(() => null)
    : null;

  if (workflowRow && workflowRow.monthlyUsd > 0) {
    return {
      monthlyUsdLimit: workflowRow.monthlyUsd,
      warningPercent: clampPercent(workflowRow.warnPercent ?? DEFAULT_WARN_PERCENT),
      policy: (workflowRow.policy as BudgetPolicy) ?? DEFAULT_POLICY,
      scope: "workflow",
    };
  }

  // Fall through to org-level config.
  try {
    const entries = await listOrgConfig(args.orgId);
    const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
    const monthlyUsd = numberOrNull(byKey.get("ai.budgetMonthlyUsd"));
    if (monthlyUsd && monthlyUsd > 0) {
      const warnRaw = numberOrNull(byKey.get("ai.budgetWarnPercent"));
      const policyRaw = stringOrNull(byKey.get("ai.budgetExceededPolicy"));
      return {
        monthlyUsdLimit: monthlyUsd,
        warningPercent: clampPercent(warnRaw ?? DEFAULT_WARN_PERCENT),
        policy: policyRaw === "block" ? "block" : DEFAULT_POLICY,
        scope: "org",
      };
    }
  } catch (err) {
    console.warn("[budget] org config read failed, returning no-budget", err);
  }

  return {
    monthlyUsdLimit: null,
    warningPercent: DEFAULT_WARN_PERCENT,
    policy: DEFAULT_POLICY,
    scope: null,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WARN_PERCENT;
  return Math.max(0, Math.min(100, value));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The production BudgetChecker registered at api + worker boot.
 * Composes the workflow override + org config + monthly usage sum into the
 * envelope the chokepoint returns.
 */
export const productionBudgetChecker: BudgetChecker = async (input) => {
  const resolved = await resolveBudget({ orgId: input.orgId, workflowId: input.workflowId ?? null });

  // No budget configured anywhere → fail-soft, allow.
  if (resolved.monthlyUsdLimit === null) {
    return {
      allowed: true,
      monthlyUsdSpent: 0,
      monthlyUsdLimit: null,
      policy: resolved.policy,
      warningPercent: resolved.warningPercent,
      warningThresholdCrossed: false,
      exceededAt: null,
      resolvedScope: null,
    };
  }

  const spent = await sumMonthlyAiCostUsd({
    orgId: input.orgId,
    workflowId: resolved.scope === "workflow" ? input.workflowId : null,
  });

  // DB hiccup → fail open with a 0 spend so the call still proceeds.
  // The chokepoint wrapper above also catches throws as defense-in-depth.
  const monthlyUsdSpent = spent ?? 0;
  const limit = resolved.monthlyUsdLimit;
  const overLimit = monthlyUsdSpent >= limit;
  const warningThresholdCrossed = monthlyUsdSpent >= (limit * resolved.warningPercent) / 100;
  const allowed = overLimit && resolved.policy === "block" ? false : true;

  return {
    allowed,
    monthlyUsdSpent,
    monthlyUsdLimit: limit,
    policy: resolved.policy,
    warningPercent: resolved.warningPercent,
    warningThresholdCrossed,
    exceededAt: overLimit ? resolved.scope : null,
    resolvedScope: resolved.scope,
  };
};

/** Convenience: produce an empty `BudgetCheckResult` for callers that need a
 *  default (e.g. routes that decide a write-side path doesn't need gating). */
export function noBudgetResult(): BudgetCheckResult {
  return {
    allowed: true,
    monthlyUsdSpent: 0,
    monthlyUsdLimit: null,
    policy: DEFAULT_POLICY,
    warningPercent: DEFAULT_WARN_PERCENT,
    warningThresholdCrossed: false,
    exceededAt: null,
    resolvedScope: null,
  };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
