import { db } from "@janusly/db";
import { usageEvents } from "@janusly/db";
import { and, eq, gte } from "drizzle-orm";

const DEFAULT_USAGE_WINDOW_DAYS = 30;
const USAGE_QUERY_LIMIT = 10_000;

export async function getUsageSummary(orgId: string, windowDays = DEFAULT_USAGE_WINDOW_DAYS) {
  // Bound the scan so a long-running org doesn't OOM the API on every dashboard
  // poll. For richer historical reporting build a pre-aggregated table.
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, since)))
    .limit(USAGE_QUERY_LIMIT);

  const summary: Record<string, number> = {};

  for (const row of rows) {
    summary[row.metric] = (summary[row.metric] ?? 0) + (row.quantity ?? 0);
  }

  return summary;
}
