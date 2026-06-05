/**
 * Unit tests for the pure audit-page keyset builder. The DB query in
 * `queryAuditLogs` is the only impure part; `buildAuditPage` is exercised
 * here without Postgres.
 */
import { describe, expect, it } from "vitest";

import { buildAuditPage, type AuditLogRow } from "@janusly/data";

function row(id: string, createdAt: Date | string): AuditLogRow {
  return {
    id,
    orgId: "org-a",
    userId: "dev-user",
    action: "workflow.saved",
    targetType: null,
    targetId: null,
    metadata: {},
    createdAt,
  };
}

describe("buildAuditPage", () => {
  it("trims to limit, sets hasMore, and builds the next cursor from the last surfaced row", () => {
    const t0 = new Date("2026-06-01T00:00:00.000Z");
    const t1 = new Date("2026-06-01T00:00:01.000Z");
    const t2 = new Date("2026-06-01T00:00:02.000Z");
    // Over-fetched (limit + 1 = 3), newest-first.
    const page = buildAuditPage([row("c", t2), row("b", t1), row("a", t0)], 2);
    expect(page.hasMore).toBe(true);
    expect(page.rows.map((r) => r.id)).toEqual(["c", "b"]);
    // Cursor points at the LAST surfaced row (b) so the next page is older.
    expect(page.nextCursor).toBe("2026-06-01T00:00:01.000Z|b");
  });

  it("reports no more + a null cursor when the result fits within the limit", () => {
    const page = buildAuditPage(
      [row("b", new Date("2026-06-01T00:00:01.000Z")), row("a", new Date("2026-06-01T00:00:00.000Z"))],
      2,
    );
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.rows).toHaveLength(2);
  });

  it("handles an empty result set", () => {
    expect(buildAuditPage([], 50)).toEqual({ rows: [], nextCursor: null, hasMore: false });
  });

  it("coerces a string createdAt into the ISO cursor token", () => {
    const page = buildAuditPage(
      [row("c", "2026-06-01T00:00:02.000Z"), row("b", "2026-06-01T00:00:01.000Z"), row("a", "2026-06-01T00:00:00.000Z")],
      2,
    );
    expect(page.nextCursor).toBe("2026-06-01T00:00:01.000Z|b");
  });
});
