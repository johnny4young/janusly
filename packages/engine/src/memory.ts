import { db } from "@workflow-engine/db";
import { runEvents } from "@workflow-engine/db";
import { eq } from "drizzle-orm";

export type MemoryEntry = {
  type: string;
  nodeId?: string | null;
  payload: any;
  createdAt?: unknown;
};

export async function appendMemory(runId: string, nodeId: string | null, payload: any) {
  await db.insert(runEvents).values({
    id: crypto.randomUUID(),
    runId,
    nodeId,
    type: "memory.appended",
    payload,
  });
}

export async function getRunMemory(runId: string, limit = 50): Promise<MemoryEntry[]> {
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));

  return events
    .filter(event => ["memory.appended", "node.succeeded", "node.failed", "node.waiting", "node.resumed"].includes(event.type))
    .slice(-limit)
    .map(event => ({
      type: event.type,
      nodeId: event.nodeId,
      payload: event.payload,
      createdAt: event.createdAt,
    }));
}

export function summarizeMemory(memory: MemoryEntry[]) {
  return memory.map((entry, index) => ({
    index,
    type: entry.type,
    nodeId: entry.nodeId,
    payload: entry.payload,
  }));
}
