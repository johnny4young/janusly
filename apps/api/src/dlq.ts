/**
 * `dead_letters` row CRUD for the API. Every helper scopes by `orgId` —
 * the DLQ is multi-tenant. `markDeadLetterReplayed` is the chokepoint
 * called after `DLQReplayAdapter` re-enqueues the failed node.
 *
 * Used by `apps/api/src/index.ts` `/dlq/*` routes.
 *
 * Invariants:
 * - Multi-tenant scope: `eq(deadLetters.orgId, orgId)` on every query.
 *   Don't surface a `dead_letters` row to the wrong org.
 */

import { db } from "@janusly/db";
import { deadLetters } from "@janusly/db";
import { eq, desc, and } from "drizzle-orm";

/** Closed enum of DLQ row statuses. */
export const deadLetterStatuses = ["open", "replayed", "resolved"] as const;
/** Inferred string-literal union for `deadLetterStatuses`. */
export type DeadLetterStatus = typeof deadLetterStatuses[number];

/** Type guard for `DeadLetterStatus`. */
export function isDeadLetterStatus(value: unknown): value is DeadLetterStatus {
  return typeof value === "string" && (deadLetterStatuses as readonly string[]).includes(value);
}

/** List DLQ rows for an org, newest first. Optional `status` filter. */
export async function listDeadLetters(orgId: string, status?: string | null) {
  const where = isDeadLetterStatus(status)
    ? and(eq(deadLetters.orgId, orgId), eq(deadLetters.status, status))
    : eq(deadLetters.orgId, orgId);

  return db.select().from(deadLetters).where(where).orderBy(desc(deadLetters.createdAt));
}

/** Fetch one DLQ row by id, scoped to the org. Returns `null` when absent. */
export async function getDeadLetter(orgId: string, id: string) {
  const rows = await db.select().from(deadLetters).where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
  return rows[0] ?? null;
}

/** Flip status to `replayed` and stamp `replayedAt`. Called after re-enqueue. */
export async function markDeadLetterReplayed(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "replayed", replayedAt: new Date() })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}

/** Flip status to `resolved` (closed without replay). */
export async function markDeadLetterResolved(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "resolved" })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}
