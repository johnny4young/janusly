import { db } from "@workflow-engine/db";
import { usageEvents } from "@workflow-engine/db";

export async function trackUsage(orgId: string, userId: string | null, runId: string, metric: string, quantity = 1, metadata: any = {}) {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId,
    userId,
    runId,
    metric,
    quantity,
    metadata,
  });
}

export async function getUsageSummary(orgId: string) {
  const rows = await db.select().from(usageEvents);

  const summary: Record<string, number> = {};

  for (const row of rows) {
    if (row.orgId !== orgId) continue;
    summary[row.metric] = (summary[row.metric] ?? 0) + (row.quantity ?? 0);
  }

  return summary;
}
