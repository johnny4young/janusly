/**
 * Unit tests for the scheduler-entry worker reads that intentionally cross
 * orgs at process boot / BullMQ trigger time. The request-path multi-tenant
 * invariant lives in the repo itself; these tests pin the extra soft-delete
 * guard so a stale `schedule_entries` row can never re-run a tombstoned
 * workflow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { whereMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
}));

vi.mock("@janusly/db", async () => {
  const actual = await vi.importActual<typeof import("@janusly/db")>("@janusly/db");
  return {
    ...actual,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: whereMock,
        })),
      })),
    },
  };
});

import { getScheduleEntry, getScheduleEntryById, listAllEnabled } from "./scheduleEntriesRepo";

const dialect = new PgDialect();

function renderedWhere(): string {
  const predicate = whereMock.mock.calls[0]?.[0];
  return dialect.sqlToQuery(predicate).sql.toLowerCase();
}

beforeEach(() => {
  whereMock.mockReset();
  whereMock.mockResolvedValue([]);
});

describe("schedule entry soft-delete guard", () => {
  it("worker trigger lookup requires the parent workflow to be active", async () => {
    await getScheduleEntryById("entry-1");

    const sql = renderedWhere();
    expect(sql).toContain("exists");
    expect(sql).toContain("workflows");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("is null");
  });

  it("worker boot replay only lists entries for active workflows", async () => {
    await listAllEnabled();

    const sql = renderedWhere();
    expect(sql).toContain("schedule_entries");
    expect(sql).toContain("enabled");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("is null");
  });

  it("org-scoped lookup also refuses entries whose workflow is tombstoned", async () => {
    await getScheduleEntry("org-1", "entry-1");

    const sql = renderedWhere();
    expect(sql).toContain("org_id");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("is null");
  });
});
