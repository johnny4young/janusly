import { db } from "@workflow-engine/db";
import { runNodes } from "@workflow-engine/db";
import { eq, and } from "drizzle-orm";

export async function getNodeStatus(runId: string, nodeId: string) {
  const result = await db.select().from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));

  return result[0]?.status;
}
