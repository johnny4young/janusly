/**
 * Idempotency table for SCIM webhook events. Every accepted event ID
 * is recorded once; `INSERT … ON CONFLICT DO NOTHING` lets the handler
 * detect replays cheaply.
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (replay guard, first step on
 *   every accepted event).
 */

import { db, scimProcessedEvents } from "@janusly/db";
import { sql } from "drizzle-orm";

/**
 * Record an event id as processed. Returns `{ fresh: true }` if the
 * insert won (this is the first time we've seen the event), or
 * `{ fresh: false }` if a row with the same id already exists (the
 * event has been replayed). Implemented via `INSERT … ON CONFLICT DO
 * NOTHING RETURNING event_id` — a single round trip, no race window.
 */
export async function recordProcessedEvent(input: {
  eventId: string;
  orgId: string;
  scimDirectoryId: string;
  eventType: string;
}): Promise<{ fresh: boolean }> {
  const rows = await db
    .insert(scimProcessedEvents)
    .values({
      eventId: input.eventId,
      orgId: input.orgId,
      scimDirectoryId: input.scimDirectoryId,
      eventType: input.eventType,
    })
    .onConflictDoNothing({ target: scimProcessedEvents.eventId })
    .returning({ eventId: scimProcessedEvents.eventId });
  return { fresh: rows.length > 0 };
}

/**
 * Release a previously-claimed event id so a retry can re-process it.
 * Called from the SCIM event handler's catch-on-throw path when the
 * dispatch fails AFTER the dedup claim was written — without this
 * release, a transient DB blip would silently lose the event because
 * WorkOS' next retry would see `fresh: false` and skip.
 *
 * Best-effort — DELETE failures are tolerated by the caller (the worst
 * case is a stuck dedup row and lost retries, which is exactly the
 * pre-release state the caller is trying to escape from).
 */
export async function deleteProcessedEvent(input: { eventId: string }): Promise<void> {
  await db.execute(sql`DELETE FROM scim_processed_events WHERE event_id = ${input.eventId}`);
}

/**
 * Delete records older than `olderThan`. Future cron will call this
 * to keep the table bounded at scale; v1 does not run it
 * automatically (10k events/day x 365 days = ~3.65M rows/year is
 * acceptable for the first wave of enterprise customers).
 */
export async function pruneOldProcessedEvents(input: { olderThan: Date }): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM scim_processed_events WHERE processed_at < ${input.olderThan}`,
  );
  return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
}
