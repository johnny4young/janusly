/**
 * AI cost budget gate for API routes.
 *
 * Every `/ai/*` route calls `gateBudget(...)` BEFORE invoking the LLM.
 * The helper runs the chokepoint, writes the matching audit row (with
 * daily de-dup for the warn path so a hot workflow doesn't pad the
 * audit log), and returns a small envelope the route uses to decide:
 *
 *  - `blocked: true` → route returns HTTP 402 with the budget envelope.
 *  - `blocked: false` + `envelope.warningThresholdCrossed: true` → route
 *    proceeds normally; the success response forwards `budget: envelope`
 *    so the web can surface a banner / toast.
 *  - clean path → route proceeds, no envelope forwarded.
 *
 * Used by `apps/api/src/routes/ai-routes.ts` for the 6 `/ai/*` routes.
 *
 * Invariants:
 * - AI fallback contract holds: even on a route-level 402, the API
 *   surfaces a `mode: "fallback"`-style envelope (status code carries the
 *   block signal; the body carries the budget envelope so the web can
 *   render a banner). The engine-side gate degrades to `mode: "fallback"`
 *   per the AI fallback contract — that's a different code path.
 * - Multi-tenant scope: audit rows are written via the existing
 *   `audit(orgId, userId, ...)` helper which already enforces scope.
 * - De-dup query is read-only; skipping a duplicate warn row never
 *   blocks the LLM call.
 * - Failures inside the gate (audit write throw, db hiccup on the
 *   de-dup query) MUST NOT break the route. The helper logs and proceeds
 *   as if the warn write succeeded; the route still sees the gate
 *   result. Matches the rate-limit fail-open posture.
 */

import { and, desc, eq, gte } from "drizzle-orm";

import { auditLogs, db } from "@janusly/db";
import { checkBudget } from "@janusly/engine/src/budget";
import {
  recordAlertEvent,
} from "@janusly/data";
import type { BudgetCheckResult } from "@janusly/shared/src/budget-types";

import { audit } from "./audit";

const BUDGET_WARN_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type GateBudgetInput = {
  orgId: string;
  userId: string;
  workflowId?: string | null;
  /** Stable identifier of the action being gated. Stored on the audit
   *  row so an operator can see "this block fired on /ai/explain-workflow". */
  action: string;
};

export type GateBudgetOutcome = {
  /** Full envelope the route forwards in success responses (when the warn
   *  threshold was crossed) or in the 402 body (when blocked). */
  envelope: BudgetCheckResult;
  /** True when the route should send HTTP 402 + the envelope instead of
   *  proceeding to the LLM call. */
  blocked: boolean;
};

/**
 * Run the budget chokepoint + write the matching audit row. Returns the
 * envelope + blocked flag the route uses to decide its next move.
 */
export async function gateBudget(input: GateBudgetInput): Promise<GateBudgetOutcome> {
  const envelope = await checkBudget({
    orgId: input.orgId,
    workflowId: input.workflowId ?? null,
  });

  // Block path. Always write an exceeded audit row (NOT de-duped — every
  // block is a real event the admin should see).
  if (!envelope.allowed) {
    try {
      await audit(input.orgId, input.userId, "billing.budget.exceeded", "ai", input.workflowId ?? undefined, {
        scope: envelope.resolvedScope,
        exceededAt: envelope.exceededAt,
        workflowId: input.workflowId ?? null,
        monthlyUsdSpent: envelope.monthlyUsdSpent,
        monthlyUsdLimit: envelope.monthlyUsdLimit,
        policy: envelope.policy,
        action: input.action,
      });
    } catch (err) {
      console.warn("[budget-gate] exceeded audit write failed", err);
    }

    // Fire the recovery-alerting hook so subscribed policies fan out via
    // Slack / webhook / email / GitHub. The DI seam is a no-op when no
    // dispatcher is registered. Never throws on caller.
    void recordAlertEvent({
      orgId: input.orgId,
      trigger: "budget.blocked",
      payload: {
        scope: envelope.resolvedScope,
        workflowId: input.workflowId ?? null,
        monthlyUsdSpent: envelope.monthlyUsdSpent,
        monthlyUsdLimit: envelope.monthlyUsdLimit,
        action: input.action,
      },
    });

    return { envelope, blocked: true };
  }

  // Warn path — de-dup within a 24h window on (orgId, scope, workflowId).
  // The lookup is a single indexed read against audit_logs_org_created_idx.
  // If the de-dup read fails, still attempt the warning audit row. Better
  // one extra row than missing a real warning.
  if (envelope.warningThresholdCrossed && envelope.monthlyUsdLimit !== null) {
    let shouldWriteWarning = true;
    try {
      const since = new Date(Date.now() - BUDGET_WARN_DEDUP_WINDOW_MS);
      const existing = await db
        .select({ id: auditLogs.id, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.orgId, input.orgId),
          eq(auditLogs.action, "billing.budget.warned"),
          gte(auditLogs.createdAt, since),
        ))
        .orderBy(desc(auditLogs.createdAt))
        .limit(20);
      const dupe = existing.find((row) => {
        const metadata = row.metadata as { scope?: unknown; workflowId?: unknown } | null;
        const sameScope = metadata?.scope === envelope.resolvedScope;
        const sameWorkflow = (metadata?.workflowId ?? null) === (input.workflowId ?? null);
        return sameScope && sameWorkflow;
      });
      shouldWriteWarning = !dupe;
    } catch (err) {
      console.warn("[budget-gate] warned audit de-dup read failed", err);
    }

    if (shouldWriteWarning) {
      try {
        await audit(input.orgId, input.userId, "billing.budget.warned", "ai", input.workflowId ?? undefined, {
          scope: envelope.resolvedScope,
          workflowId: input.workflowId ?? null,
          monthlyUsdSpent: envelope.monthlyUsdSpent,
          monthlyUsdLimit: envelope.monthlyUsdLimit,
          warningPercent: envelope.warningPercent,
          policy: envelope.policy,
          action: input.action,
        });
      } catch (err) {
        console.warn("[budget-gate] warned audit write failed", err);
      }
    }
  }

  return { envelope, blocked: false };
}

/** Build the 402 response body for a budget-blocked LLM route. */
export function budgetBlockedResponse(envelope: BudgetCheckResult) {
  return {
    error: "budget_exceeded",
    code: "budget_exceeded" as const,
    params: {
      monthlyUsdSpent: envelope.monthlyUsdSpent,
      ...(envelope.monthlyUsdLimit === null ? {} : { monthlyUsdLimit: envelope.monthlyUsdLimit }),
      policy: envelope.policy,
      warningPercent: envelope.warningPercent,
      ...(envelope.exceededAt === null ? {} : { exceededAt: envelope.exceededAt }),
      ...(envelope.resolvedScope === null ? {} : { resolvedScope: envelope.resolvedScope }),
    },
    budget: envelope,
  };
}

/** Merge a non-blocked envelope into a successful route response so the
 *  web can render a warning banner when warningThresholdCrossed is true. */
export function attachBudgetEnvelope<T extends Record<string, unknown>>(
  response: T,
  envelope: BudgetCheckResult,
): T & { budget: BudgetCheckResult } {
  return { ...response, budget: envelope };
}
