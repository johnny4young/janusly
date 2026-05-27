/**
 * Repository for `routing_stats` — the per-(org, node) reinforcement counters
 * that drive the runtime's RL-flavoured router selection.
 *
 * Each row tracks `pulls`, `value` (cumulative reward), `meanReward`, and
 * success/failure counts for one routing candidate. The decision engine
 * reads them via `getRoutingStats`; node executors update them through
 * `updateRoutingStats` once a run resolves a routing decision.
 *
 * Used by:
 * - `packages/domain/src/decisionEngine.ts` — reads stats to bias candidate
 *   scoring.
 * - `packages/engine/src/core/runtime.ts` — calls `updateRoutingStats` after
 *   a `router` node completes.
 *
 * Invariants:
 * - All queries scope on `orgId`. Calls without `orgId` return early so
 *   anonymous/unauthenticated paths don't accidentally write global rows.
 * - On first use of an (org, node) pair we INSERT; subsequent updates UPDATE
 *   in place. There's no concurrency-safe upsert here yet — multi-replica
 *   writes for the same node could race.
 */

import { db, routingStats } from "@janusly/db";
import { and, eq } from "drizzle-orm";

/** Load all routing stats for an org as `{ [nodeId]: row }`. */
export async function getRoutingStats(orgId: string) {
  const rows = await db.select().from(routingStats).where(eq(routingStats.orgId, orgId));

  return Object.fromEntries(rows.map((row) => [row.nodeId, row]));
}

/**
 * Apply one reinforcement update for a (org, node) pair. Returns immediately
 * (no-op) when `orgId` is undefined — keeps anonymous code paths from
 * silently writing to a global bucket.
 */
export async function updateRoutingStats({
  orgId,
  nodeId,
  reward,
  success,
}: {
  orgId?: string;
  nodeId: string;
  reward: number;
  success: boolean;
}) {
  if (!orgId) return;

  const existing = await db
    .select()
    .from(routingStats)
    .where(and(eq(routingStats.orgId, orgId), eq(routingStats.nodeId, nodeId)));

  if (!existing[0]) {
    await db.insert(routingStats).values({
      id: crypto.randomUUID(),
      orgId,
      nodeId,
      pulls: 1,
      value: reward,
      meanReward: reward,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
    });
    return;
  }

  const current = existing[0];
  const pulls = (current.pulls ?? 0) + 1;
  const value = Number(current.value ?? 0) + reward;
  const meanReward = value / pulls;

  await db
    .update(routingStats)
    .set({
      pulls,
      value,
      meanReward,
      successCount: (current.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (current.failureCount ?? 0) + (success ? 0 : 1),
      updatedAt: new Date(),
    })
    .where(eq(routingStats.id, current.id));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
