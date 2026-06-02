/**
 * Per-workflow AI budget overrides — CRUD repo for `workflow_budgets`.
 *
 * A row here narrows the org-level budget for one specific workflow. The
 * org-level budget lives in `org_configs.ai.budgetMonthlyUsd`; the budget
 * chokepoint resolves "workflow row if present, else org config".
 *
 * Multi-tenant scope: every query carries `eq(workflowBudgets.orgId, orgId)`.
 * Unique constraint on `(orgId, workflowId)` makes the upsert straightforward.
 *
 * Used by:
 * - `packages/data/src/budgetRepo.ts` (production wiring of the budget
 *   chokepoint DI seam).
 * - `apps/api/src/routes/billing-routes.ts` (admin budget route).
 */

import { and, eq } from "drizzle-orm";
import { db, workflowBudgets } from "@janusly/db";

export type WorkflowBudgetPolicy = "warn" | "block";

export type WorkflowBudgetRow = {
  id: string;
  orgId: string;
  workflowId: string;
  monthlyUsd: number;
  warnPercent: number;
  policy: WorkflowBudgetPolicy;
  updatedBy: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

export type WorkflowBudgetUpsertInput = {
  orgId: string;
  workflowId: string;
  monthlyUsd: number;
  warnPercent?: number;
  policy?: WorkflowBudgetPolicy;
  updatedBy?: string | null;
};

/** Read the budget row for `(orgId, workflowId)`, or `null` if unset. */
export async function getWorkflowBudget(orgId: string, workflowId: string): Promise<WorkflowBudgetRow | null> {
  const rows = await db
    .select()
    .from(workflowBudgets)
    .where(and(eq(workflowBudgets.orgId, orgId), eq(workflowBudgets.workflowId, workflowId)));
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    workflowId: row.workflowId,
    monthlyUsd: row.monthlyUsd,
    warnPercent: row.warnPercent,
    policy: row.policy as WorkflowBudgetPolicy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Insert-or-update the budget row. Sets `updatedAt` to now() on every write. */
export async function upsertWorkflowBudget(input: WorkflowBudgetUpsertInput): Promise<WorkflowBudgetRow> {
  if (!Number.isFinite(input.monthlyUsd) || input.monthlyUsd < 0) {
    throw new Error("monthlyUsd must be a finite number >= 0");
  }
  if (
    input.warnPercent !== undefined
    && (!Number.isInteger(input.warnPercent) || input.warnPercent < 0 || input.warnPercent > 100)
  ) {
    throw new Error("warnPercent must be an integer between 0 and 100");
  }
  const policy = input.policy ?? "warn";
  if (policy !== "warn" && policy !== "block") throw new Error("policy must be 'warn' or 'block'");

  const existing = await getWorkflowBudget(input.orgId, input.workflowId);
  if (existing) {
    await db
      .update(workflowBudgets)
      .set({
        monthlyUsd: input.monthlyUsd,
        warnPercent: input.warnPercent ?? existing.warnPercent,
        policy,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowBudgets.orgId, input.orgId), eq(workflowBudgets.workflowId, input.workflowId)));
    const row = await getWorkflowBudget(input.orgId, input.workflowId);
    if (!row) throw new Error("workflow budget vanished after update");
    return row;
  }
  const id = crypto.randomUUID();
  await db.insert(workflowBudgets).values({
    id,
    orgId: input.orgId,
    workflowId: input.workflowId,
    monthlyUsd: input.monthlyUsd,
    warnPercent: input.warnPercent ?? 80,
    policy,
    updatedBy: input.updatedBy ?? null,
  });
  const row = await getWorkflowBudget(input.orgId, input.workflowId);
  if (!row) throw new Error("workflow budget vanished after insert");
  return row;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
