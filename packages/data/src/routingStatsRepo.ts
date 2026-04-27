import { db, routingStats } from "@janusly/db";
import { and, eq } from "drizzle-orm";

export async function getRoutingStats(orgId: string) {
  const rows = await db.select().from(routingStats).where(eq(routingStats.orgId, orgId));

  return Object.fromEntries(rows.map((row) => [row.nodeId, row]));
}

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
