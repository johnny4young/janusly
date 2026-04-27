import { db } from "@janusly/db";
import { deadLetters } from "@janusly/db";
import { eq, desc, and } from "drizzle-orm";

export const deadLetterStatuses = ["open", "replayed", "resolved"] as const;
export type DeadLetterStatus = typeof deadLetterStatuses[number];

export function isDeadLetterStatus(value: unknown): value is DeadLetterStatus {
  return typeof value === "string" && (deadLetterStatuses as readonly string[]).includes(value);
}

export async function listDeadLetters(orgId: string, status?: string | null) {
  const where = isDeadLetterStatus(status)
    ? and(eq(deadLetters.orgId, orgId), eq(deadLetters.status, status))
    : eq(deadLetters.orgId, orgId);

  return db.select().from(deadLetters).where(where).orderBy(desc(deadLetters.createdAt));
}

export async function getDeadLetter(orgId: string, id: string) {
  const rows = await db.select().from(deadLetters).where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
  return rows[0] ?? null;
}

export async function markDeadLetterReplayed(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "replayed", replayedAt: new Date() })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}

export async function markDeadLetterResolved(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "resolved" })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}
