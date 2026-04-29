import { describe, expect, it } from "vitest";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit } from "./run-pagination";

type FakeEvent = { id: string; createdAt: Date | null };

function makeEvents(count: number): FakeEvent[] {
  const start = Date.UTC(2026, 3, 1);
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i.toString().padStart(4, "0")}`,
    createdAt: new Date(start + i * 1000),
  }));
}

describe("paginateRunEvents", () => {
  it("returns ASC-ordered events when the page is full and reports hasMore", () => {
    const ascending = makeEvents(10);
    const limit = 5;
    const desc = ascending.slice(-limit - 1).reverse();

    const page = paginateRunEvents(desc, limit);

    expect(page.events).toHaveLength(limit);
    expect(page.events.map((e) => e.id)).toEqual(["evt-0005", "evt-0006", "evt-0007", "evt-0008", "evt-0009"]);
    expect(page.eventsHasMore).toBe(true);
    expect(page.eventsCursor).toBe(`${page.events[0].createdAt!.toISOString()}|${page.events[0].id}`);
  });

  it("reports hasMore=false and null cursor when fewer rows than limit", () => {
    const ascending = makeEvents(3);
    const desc = [...ascending].reverse();

    const page = paginateRunEvents(desc, 5);

    expect(page.events).toHaveLength(3);
    expect(page.events.map((e) => e.id)).toEqual(["evt-0000", "evt-0001", "evt-0002"]);
    expect(page.eventsHasMore).toBe(false);
    expect(page.eventsCursor).toBeNull();
  });

  it("treats exact-multiple page boundary as no-more-data", () => {
    const ascending = makeEvents(5);
    const desc = [...ascending].reverse();

    const page = paginateRunEvents(desc, 5);

    expect(page.events).toHaveLength(5);
    expect(page.eventsHasMore).toBe(false);
    expect(page.eventsCursor).toBeNull();
  });

  it("handles empty input", () => {
    const page = paginateRunEvents<FakeEvent>([], 10);
    expect(page.events).toEqual([]);
    expect(page.eventsHasMore).toBe(false);
    expect(page.eventsCursor).toBeNull();
  });

  it("walks the full history page-by-page using composite cursors", () => {
    const total = makeEvents(12);
    const limit = 5;

    function fetchPage(cursor: { createdAt: Date; id: string } | null) {
      const filtered = !cursor
        ? total
        : total.filter((e) => {
            if (!e.createdAt) return false;
            if (e.createdAt.getTime() < cursor.createdAt.getTime()) return true;
            return e.createdAt.getTime() === cursor.createdAt.getTime() && e.id < cursor.id;
          });
      const desc = [...filtered].reverse().slice(0, limit + 1);
      return paginateRunEvents(desc, limit);
    }

    const page1 = fetchPage(null);
    expect(page1.events.map((e) => e.id)).toEqual(["evt-0007", "evt-0008", "evt-0009", "evt-0010", "evt-0011"]);
    expect(page1.eventsHasMore).toBe(true);

    const page2 = fetchPage(parseEventsCursor(page1.eventsCursor));
    expect(page2.events.map((e) => e.id)).toEqual(["evt-0002", "evt-0003", "evt-0004", "evt-0005", "evt-0006"]);
    expect(page2.eventsHasMore).toBe(true);

    const page3 = fetchPage(parseEventsCursor(page2.eventsCursor));
    expect(page3.events.map((e) => e.id)).toEqual(["evt-0000", "evt-0001"]);
    expect(page3.eventsHasMore).toBe(false);
    expect(page3.eventsCursor).toBeNull();
  });

  it("encodes a composite cursor for events that share an exact createdAt", () => {
    const at = new Date("2026-04-29T10:00:00.000Z");
    // Server orders by `desc(createdAt), desc(id)`; for ties this is descending id.
    const descPlusOne: FakeEvent[] = [
      { id: "evt-d", createdAt: at },
      { id: "evt-c", createdAt: at },
      { id: "evt-b", createdAt: at },
      { id: "evt-a", createdAt: at },
    ];

    const page = paginateRunEvents(descPlusOne, 3);

    // Page is the first 3 of desc-id, reversed to ascending: [b, c, d].
    expect(page.events.map((e) => e.id)).toEqual(["evt-b", "evt-c", "evt-d"]);
    expect(page.eventsHasMore).toBe(true);
    const parsed = parseEventsCursor(page.eventsCursor);
    expect(parsed?.id).toBe("evt-b");
    expect(parsed?.createdAt.toISOString()).toBe(at.toISOString());
  });
});

describe("parseEventsLimit", () => {
  it("returns the default when the param is missing or non-numeric", () => {
    expect(parseEventsLimit(null, 200, 500)).toBe(200);
    expect(parseEventsLimit("", 200, 500)).toBe(200);
    expect(parseEventsLimit("abc", 200, 500)).toBe(200);
    expect(parseEventsLimit("0", 200, 500)).toBe(200);
    expect(parseEventsLimit("-50", 200, 500)).toBe(200);
  });

  it("caps at the maximum", () => {
    expect(parseEventsLimit("10000", 200, 500)).toBe(500);
  });

  it("respects the requested value when within range", () => {
    expect(parseEventsLimit("75", 200, 500)).toBe(75);
  });

  it("floors fractional inputs", () => {
    expect(parseEventsLimit("75.9", 200, 500)).toBe(75);
  });
});

describe("parseEventsCursor", () => {
  it("returns null for missing or empty input", () => {
    expect(parseEventsCursor(null)).toBeNull();
    expect(parseEventsCursor("")).toBeNull();
  });

  it("returns null for malformed cursors without a separator", () => {
    expect(parseEventsCursor("not-a-cursor")).toBeNull();
  });

  it("returns null when the timestamp half is invalid", () => {
    expect(parseEventsCursor("not-a-date|evt-1")).toBeNull();
  });

  it("returns null when the id half is empty", () => {
    expect(parseEventsCursor("2026-04-01T00:00:05.000Z|")).toBeNull();
  });

  it("parses a composite cursor", () => {
    const iso = "2026-04-01T00:00:05.000Z";
    const parsed = parseEventsCursor(`${iso}|evt-42`);
    expect(parsed?.createdAt.toISOString()).toBe(iso);
    expect(parsed?.id).toBe("evt-42");
  });
});
