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

export const DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE = 10_000;
export const DEFAULT_SCIM_EVENTS_PRUNE_MAX_BATCHES = 1_000;

export type PruneOldProcessedEventsInput = {
  /** Drop rows with `processed_at` strictly older than this date. */
  olderThan: Date;
  /** Rows per DELETE batch. Default 10_000. */
  batchSize?: number;
  /** Hard upper bound on iterations so a misconfigured cutoff
   *  cannot spin forever. Default 1_000 → 10M-row sweep ceiling. */
  maxBatches?: number;
};

export type PruneOldProcessedEventsResult = {
  /** Total rows removed across all batches. */
  rowsDeleted: number;
  /** ISO timestamp of the cutoff used (`input.olderThan` echoed back). */
  cutoffAt: string;
  /** Wallclock duration of the entire sweep including all batches. */
  runtimeMs: number;
  /** True if the loop exited because `maxBatches` was reached — more
   *  rows may still be expired; next fire continues. */
  cappedByMaxBatches: boolean;
};

/**
 * Purge SCIM dedup rows older than `olderThan`, batched. The
 * `scim_processed_events_processed_at_idx` index (on
 * `processed_at`) accelerates the inner SELECT so each round-trip
 * removes at most `batchSize` rows in a short transaction.
 *
 * Returns the aggregate count + timing. The scheduler caller writes
 * one `scim.event_log.retention.purged` system-sentinel audit row per
 * fire with the returned metadata.
 */
export async function pruneOldProcessedEvents(
  input: PruneOldProcessedEventsInput,
): Promise<PruneOldProcessedEventsResult> {
  const batchSize = input.batchSize ?? DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? DEFAULT_SCIM_EVENTS_PRUNE_MAX_BATCHES;
  const cutoffAt = input.olderThan.toISOString();
  const startedAt = Date.now();

  let rowsDeleted = 0;
  let cappedByMaxBatches = false;
  for (let i = 0; i < maxBatches; i += 1) {
    // postgres-js doesn't auto-serialize JS Date objects in bound
    // params — pass the ISO string + `::timestamptz` cast so Postgres
    // does the conversion server-side.
    const result = await db.execute<{ event_id: string }>(sql`
      DELETE FROM ${scimProcessedEvents}
      WHERE ${scimProcessedEvents.eventId} IN (
        SELECT ${scimProcessedEvents.eventId} FROM ${scimProcessedEvents}
        WHERE ${scimProcessedEvents.processedAt} < ${cutoffAt}::timestamptz
        LIMIT ${batchSize}
      )
      RETURNING ${scimProcessedEvents.eventId}
    `);
    const deletedThisBatch = result.length;
    rowsDeleted += deletedThisBatch;
    // Ordering is load-bearing: the early-return MUST precede the
    // cap-flag set. A sweep that happens to finish exactly on the last
    // iteration with a short batch is NOT capped — there were no more
    // expired rows. Reversing the two `if`s would mis-report
    // `cappedByMaxBatches: true` in that edge case.
    if (deletedThisBatch < batchSize) {
      return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
    }
    if (i === maxBatches - 1) {
      cappedByMaxBatches = true;
    }
  }
  return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
