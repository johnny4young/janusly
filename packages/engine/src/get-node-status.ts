/**
 * Single-row read for a (runId, nodeId) status. Used by the `ExecutionStore`
 * adapter; kept as a standalone helper so non-adapter callers can read
 * status without instantiating the full store.
 */

import { db } from "@janusly/db";
import { runNodes } from "@janusly/db";
import { eq, and } from "drizzle-orm";

/** Return the current `status` of a (runId, nodeId) pair, or `undefined` when absent. */
export async function getNodeStatus(runId: string, nodeId: string) {
  const result = await db.select().from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));

  return result[0]?.status;
}
