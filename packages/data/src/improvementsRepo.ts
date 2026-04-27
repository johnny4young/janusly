import { db, workflowImprovements } from "@workflow-engine/db";
import { desc, eq, and } from "drizzle-orm";

export type WorkflowMetrics = {
  successRate?: number;
  avgLatencyMs?: number;
  avgCost?: number;
};

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

export async function listWorkflowImprovements(orgId: string, workflowId: string) {
  return db
    .select()
    .from(workflowImprovements)
    .where(and(eq(workflowImprovements.orgId, orgId), eq(workflowImprovements.workflowId, workflowId)))
    .orderBy(desc(workflowImprovements.createdAt));
}
