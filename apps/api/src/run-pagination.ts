/**
 * Composite-cursor pagination for `GET /run` and `GET /status` event lists.
 * The cursor is `<iso>|<eventId>`: events sharing exact
 * `createdAt` (e.g. inserts within one transaction) tie-break on `id` so
 * pagination always advances and never skips peers.
 *
 * Used by `apps/api/src/index.ts` `/run` and `/status` route handlers.
 *
 * Invariants:
 * - The query orders by `(createdAt DESC, id DESC)` and the cursor parser
 *   matches that ordering. Don't change one without the other.
 * - Limit cap defaults to 200 (max 500). The route caller enforces; this
 *   module just parses.
 */

/** Minimal row shape the paginator needs — matches `runEvents` Drizzle row. */
type PaginatedEvent = { id: string; createdAt: Date | null };

/** Parsed cursor — `(createdAt, id)` keyset position. */
export type EventsCursor = { createdAt: Date; id: string };

const CURSOR_SEPARATOR = "|";

/**
 * Build the page payload for an over-fetched (`limit + 1`) descending
 * result set. Returns ascending events (the web wants chronological
 * order), an `eventsHasMore` flag, and a next-page cursor when applicable.
 */
export function paginateRunEvents<T extends PaginatedEvent>(
  rowsDescending: T[],
  limit: number,
): { events: T[]; eventsCursor: string | null; eventsHasMore: boolean } {
  const hasMore = rowsDescending.length > limit;
  const trimmed = hasMore ? rowsDescending.slice(0, limit) : rowsDescending;
  const ascending = [...trimmed].reverse();
  const oldest = ascending[0];
  const oldestCreatedAt = oldest?.createdAt ?? null;
  return {
    events: ascending,
    eventsHasMore: hasMore,
    eventsCursor: hasMore && oldest && oldestCreatedAt
      ? `${oldestCreatedAt.toISOString()}${CURSOR_SEPARATOR}${oldest.id}`
      : null,
  };
}

/** Parse `?eventsLimit=` with bounds; falls back to `defaultLimit` on bad input. */
export function parseEventsLimit(raw: string | null, defaultLimit: number, maxLimit: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(Math.floor(parsed), maxLimit);
}

/** Parse `?eventsCursor=<iso>|<id>`. Returns `null` for malformed / missing cursors. */
export function parseEventsCursor(raw: string | null): EventsCursor | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf(CURSOR_SEPARATOR);
  if (sep === -1) return null;
  const isoPart = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id) return null;
  const createdAt = new Date(isoPart);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}
