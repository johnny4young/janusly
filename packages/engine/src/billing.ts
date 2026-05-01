/**
 * Bounded `usage_events` aggregator. Sums `quantity` per `metric` over a
 * recent time window. The 30-day / 10k-row cap keeps a long-running org from
 * OOMing the API on every dashboard poll. The shared LLM recorder writes the
 * rows this query reads.
 *
 * Used by `apps/api/src/index.ts` `GET /billing/usage`, which the web's
 * "Usage summary" card consumes.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries `eq(usageEvents.orgId, orgId)`.
 * - Don't unbound the scan. If richer historical reporting matters, build a
 *   pre-aggregated table — don't widen the window here.
 */

import { db } from "@janusly/db";
import { usageEvents } from "@janusly/db";
import { and, eq, gte } from "drizzle-orm";

const DEFAULT_USAGE_WINDOW_DAYS = 30;
const USAGE_QUERY_LIMIT = 10_000;

/** Aggregate `usage_events.quantity` per `metric` for one org over the last `windowDays`. */
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
