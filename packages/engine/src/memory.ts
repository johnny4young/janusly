import { db } from "@janusly/db";
import { runEvents } from "@janusly/db";
import { asc, eq } from "drizzle-orm";

export type MemoryEntry = {
  type: string;
  nodeId?: string | null;
  payload: any;
  createdAt?: unknown;
};

export async function getRunMemory(runId: string, limit = 50): Promise<MemoryEntry[]> {
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));

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
