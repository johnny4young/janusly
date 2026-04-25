import { db } from "@workflow-engine/db";
import { runNodes, runEvents } from "@workflow-engine/db";
import { eq, and } from "drizzle-orm";

export async function markNodeRunning(runId: string, nodeId: string) {
  await db.update(runNodes)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeQueued(runId: string, nodeId: string) {
  await db.update(runNodes)
    .set({ status: "queued" })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeWaiting(runId: string, nodeId: string, metadata?: any) {
  await db.update(runNodes)
    .set({ status: "waiting", stateJson: { waiting: metadata ?? {} } })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeSucceeded(runId: string, nodeId: string, output?: any) {
  await db.update(runNodes)
    .set({ status: "succeeded", stateJson: { output: output ?? {} }, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeFailed(runId: string, nodeId: string, error: any) {
  await db.update(runNodes)
    .set({ status: "failed", errorJson: error, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function appendEvent(runId: string, nodeId: string | null, type: string, payload: any) {
  await db.insert(runEvents).values({
    id: crypto.randomUUID(),
    runId,
    nodeId,
    type,
    payload,
  });
}

export async function getRunContext(runId: string) {
  const rows = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  return rows.reduce<Record<string, any>>((acc, row) => {
    acc[row.nodeId] = {
      status: row.status,
      state: row.stateJson ?? {},
      output: (row.stateJson as any)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}
