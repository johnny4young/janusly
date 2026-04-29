type PaginatedEvent = { id: string; createdAt: Date | null };

export type EventsCursor = { createdAt: Date; id: string };

const CURSOR_SEPARATOR = "|";

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

export function parseEventsLimit(raw: string | null, defaultLimit: number, maxLimit: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(Math.floor(parsed), maxLimit);
}

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
