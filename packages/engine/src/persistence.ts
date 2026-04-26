import { db } from "@workflow-engine/db";
import { runNodes, runEvents, runs } from "@workflow-engine/db";
import { eq, and, inArray } from "drizzle-orm";

export async function getRunStatus(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0]?.status ?? null;
}

export async function cancelRun(runId: string, reason?: any) {
  await db.update(runs)
    .set({ status: "cancelled" })
    .where(eq(runs.id, runId));

  await db.update(runNodes)
    .set({ status: "cancelled", stateJson: { cancelled: reason ?? {} }, finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), inArray(runNodes.status, ["pending", "queued", "waiting"])));

  await appendEvent(runId, null, "run.cancelled", reason ?? {});
}

export async function markNodeRunning(runId: string, nodeId: string, attempt = 1) {
  await db.update(runNodes)
    .set({ status: "running", attempts: attempt, startedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeQueued(runId: string, nodeId: string, attempt = 1) {
  await db.update(runNodes)
    .set({ status: "queued", attempts: attempt })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeWaiting(runId: string, nodeId: string, metadata?: any) {
  await db.update(runNodes)
    .set({ status: "waiting", stateJson: { waiting: metadata ?? {} } })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

export async function markNodeSkipped(runId: string, nodeId: string, reason?: any) {
  await db.update(runNodes)
    .set({ status: "skipped", stateJson: { skipped: reason ?? {} }, finishedAt: new Date() })
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

export async function updateRunStatusFromNodes(runId: string) {
  const status = await getRunStatus(runId);
  if (status === "cancelled") return "cancelled";

  const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  if (nodes.some(node => node.status === "failed")) {
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
    return "failed";
  }

  const openStatuses = new Set(["pending", "queued", "running", "waiting"]);
  if (nodes.length > 0 && nodes.every(node => !openStatuses.has(node.status))) {
    await db.update(runs).set({ status: "succeeded" }).where(eq(runs.id, runId));
    return "succeeded";
  }

  return "running";
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
      attempts: row.attempts ?? 0,
      state: row.stateJson ?? {},
      output: (row.stateJson as any)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}
