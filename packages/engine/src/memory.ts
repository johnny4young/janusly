/**
 * Agent run memory — pulls a recent slice of `run_events` for embedding in
 * the next agent loop's prompt. The selection filters event types that
 * carry meaningful agent context (succeeded/failed/waiting/resumed/memory
 * append) and caps to the most recent `limit` entries.
 *
 * Used by `node-registry.ts:runAgentLoop` (every iteration of `agent` /
 * `multi_agent` nodes) to give the planner access to prior steps.
 */

import { db, runEvents } from "@janusly/db";
import { asc, eq } from "drizzle-orm";

/** One memory entry, lifted from a `run_events` row. */
export type MemoryEntry = {
  type: string;
  nodeId?: string | null;
  payload: any;
  createdAt?: unknown;
};

/** Read the last `limit` agent-relevant events for `runId`, oldest-first. */
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

/** Project memory entries to a planner-friendly shape (drops `createdAt`, adds `index`). */
export function summarizeMemory(memory: MemoryEntry[]) {
  return memory.map((entry, index) => ({
    index,
    type: entry.type,
    nodeId: entry.nodeId,
    payload: entry.payload,
  }));
}
