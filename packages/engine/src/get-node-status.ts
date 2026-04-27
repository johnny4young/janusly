import { db } from "@janusly/db";
import { runNodes } from "@janusly/db";
import { eq, and } from "drizzle-orm";

export async function getNodeStatus(runId: string, nodeId: string) {
  const result = await db.select().from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));

  return result[0]?.status;
}
