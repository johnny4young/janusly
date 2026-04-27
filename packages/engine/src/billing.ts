import { db } from "@janusly/db";
import { usageEvents } from "@janusly/db";
import { eq } from "drizzle-orm";

export async function getUsageSummary(orgId: string) {
  const rows = await db.select().from(usageEvents).where(eq(usageEvents.orgId, orgId));

  const summary: Record<string, number> = {};

  for (const row of rows) {
    summary[row.metric] = (summary[row.metric] ?? 0) + (row.quantity ?? 0);
  }

  return summary;
}
