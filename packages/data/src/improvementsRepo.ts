/**
 * Repository for `workflow_improvements` — the improvement-engine's bookkeeping
 * table. Each row is one decision the improvement engine made (apply / hold /
 * rollback) with `before/afterMetrics` and a confidence score.
 *
 * Used by:
 * - `packages/domain/src/improvementEngine.ts` — calls `record...` after each
 *   evaluation cycle.
 * - `apps/api/src/index.ts` — surfaces `list...` to the Improvements panel.
 *
 * Invariants:
 * - Every read filters on `orgId` (multi-tenant scope).
 * - Inserts mint a fresh `crypto.randomUUID()` id; no upserts.
 */

import { db, workflowImprovements } from "@janusly/db";
import { desc, eq, and } from "drizzle-orm";

/** Aggregate metrics the improvement engine compares before/after. */
export type WorkflowMetrics = {
  successRate?: number;
  avgLatencyMs?: number;
  avgCost?: number;
};

/** Persist one improvement-engine decision to `workflow_improvements`. */
export async function recordWorkflowImprovement(input: {
  orgId: string;
  workflowId: string;
  baseVersion?: number;
  newVersion?: number;
  action?: unknown;
  reason?: string;
  beforeMetrics?: WorkflowMetrics;
  afterMetrics?: WorkflowMetrics;
  confidence: number;
  status: string;
}) {
  const id = crypto.randomUUID();
  await db.insert(workflowImprovements).values({ id, ...input });
  return { id };
}

/** Fetch all improvement decisions for a (org, workflow) pair, newest first. */
export async function listWorkflowImprovements(orgId: string, workflowId: string) {
  return db
    .select()
    .from(workflowImprovements)
    .where(and(eq(workflowImprovements.orgId, orgId), eq(workflowImprovements.workflowId, workflowId)))
    .orderBy(desc(workflowImprovements.createdAt));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
