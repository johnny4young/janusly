import { db } from "@workflow-engine/db";
import { runEvents } from "@workflow-engine/db";
import { eq } from "drizzle-orm";

export async function getRoutingStats(orgId: string) {
  // simple stub (can evolve to table later)
  return {};
}

export async function updateRoutingStats({
  orgId,
  nodeId,
  reward,
}: {
  orgId?: string;
  nodeId: string;
  reward: number;
}) {
  // TODO: replace with real table
  await db.insert(runEvents).values({
    id: crypto.randomUUID(),
    runId: "learning",
    nodeId,
    type: "rl.feedback",
    payload: { reward, orgId },
  });
}
