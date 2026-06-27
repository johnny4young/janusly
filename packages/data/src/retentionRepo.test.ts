/**
 * Pure-unit tests for the per-org retention purge helpers + the
 * export-before-delete seam.
 *
 * `@janusly/db` is mocked so `db.execute` is a controllable spy; the real
 * drizzle `sql` template is kept (not mocked) and the captured SQL is
 * rendered via `PgDialect.sqlToQuery` so we can assert the tenant scope
 * (`org_id = $orgId`) and the legal-hold bypass (`hold_until IS NULL OR
 * hold_until <= now()`) are present on every DELETE. No real DB is hit.
 *
 * Covers AC cases: hold bypass, export-before-delete seam, cross-org
 * isolation (per-call orgId param), and the batched-loop bounds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ─── Mocks (must come BEFORE the repo import) ────────────────────────────────

// `vi.mock` is hoisted above all top-level statements, so the spy it
// references must be created via `vi.hoisted` (also hoisted) to exist by
// the time the factory runs.
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

// Keep the REAL drizzle table objects (so column references render as
// proper SQL identifiers like `hold_until` / `org_id`) and override only
// the `db` client with a spy on `execute`.
vi.mock("@janusly/db", async () => {
  const actual = await vi.importActual<typeof import("@janusly/db")>("@janusly/db");
  return { ...actual, db: { execute: executeMock } };
});

import {
  deleteExpiredAuditLogsForOrg,
  deleteExpiredMemoryEntriesForOrg,
  deleteExpiredRecoveryFeedbackForOrg,
  deleteExpiredRunEventsForOrg,
  deleteExpiredSoftDeletedWorkflowsForOrg,
  deleteExpiredUsageEventsForOrg,
  listOrgIdsForRetention,
  runRetentionExport,
  setRetentionExporter,
} from "./retentionRepo";

const dialect = new PgDialect();

/** Render every captured `db.execute(sql)` call into `{ sql, params }`. */
function renderedCalls(): Array<{ sql: string; params: unknown[] }> {
  return executeMock.mock.calls.map((call) => {
    const rendered = dialect.sqlToQuery(call[0]);
    return { sql: rendered.sql, params: rendered.params as unknown[] };
  });
}

beforeEach(() => {
  executeMock.mockReset();
});

afterEach(() => {
  setRetentionExporter(null);
});

describe("legal-hold bypass + tenant scope on every per-table DELETE", () => {
  const purgers: Array<[string, (input: { orgId: string; retentionDays: number }) => Promise<unknown>]> = [
    ["run_events", deleteExpiredRunEventsForOrg],
    ["audit_logs", deleteExpiredAuditLogsForOrg],
    ["usage_events", deleteExpiredUsageEventsForOrg],
    ["recovery_feedback", deleteExpiredRecoveryFeedbackForOrg],
    ["memory_entries", deleteExpiredMemoryEntriesForOrg],
  ];

  it.each(purgers)("%s DELETE carries the hold_until bypass conjunct", async (_label, purge) => {
    executeMock.mockResolvedValueOnce([]); // short batch → single round trip
    await purge({ orgId: "org_a", retentionDays: 90 });
    const [first] = renderedCalls();
    expect(first.sql).toContain("hold_until");
    expect(first.sql.toLowerCase()).toContain("is null");
    expect(first.sql.toLowerCase()).toContain("<= now()");
  });

  it.each(purgers)("%s DELETE binds the orgId param (cross-org scope)", async (_label, purge) => {
    executeMock.mockResolvedValueOnce([]);
    await purge({ orgId: "org_specific", retentionDays: 90 });
    const [first] = renderedCalls();
    expect(first.params).toContain("org_specific");
  });

  it("run_events scopes through the parent runs table (no org column of its own)", async () => {
    executeMock.mockResolvedValueOnce([]);
    await deleteExpiredRunEventsForOrg({ orgId: "org_a", retentionDays: 90 });
    const [first] = renderedCalls();
    // The join onto runs is what gives run_events its tenant scope.
    expect(first.sql.toLowerCase()).toContain("join");
  });

  it("binds the retention cutoff as a timestamptz-cast ISO string param", async () => {
    executeMock.mockResolvedValueOnce([]);
    const before = Date.now() - 91 * 24 * 60 * 60 * 1000;
    await deleteExpiredAuditLogsForOrg({ orgId: "org_a", retentionDays: 91 });
    const [first] = renderedCalls();
    expect(first.sql).toContain("::timestamptz");
    const isoParam = first.params.find((p) => typeof p === "string" && p.endsWith("Z")) as string;
    expect(isoParam).toBeDefined();
    // Cutoff is ~91 days ago (allow generous slack for test wallclock).
    const after = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.parse(isoParam);
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 5_000);
    expect(cutoffMs).toBeLessThanOrEqual(after + 5_000);
  });
});

describe("batched-loop bounds", () => {
  it("accumulates rowsDeleted and stops on a short batch", async () => {
    // First batch full (2 rows), second batch short (1 row) → loop ends.
    executeMock
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }]);
    const result = await deleteExpiredUsageEventsForOrg({
      orgId: "org_a",
      retentionDays: 90,
      batchSize: 2,
    });
    expect(result.rowsDeleted).toBe(3);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("flags cappedByMaxBatches when every batch is full up to maxBatches", async () => {
    // Always returns a full batch → the maxBatches cap is the only exit.
    executeMock.mockResolvedValue([{ id: "x" }]);
    const result = await deleteExpiredAuditLogsForOrg({
      orgId: "org_a",
      retentionDays: 30,
      batchSize: 1,
      maxBatches: 3,
    });
    expect(result.rowsDeleted).toBe(3);
    expect(result.cappedByMaxBatches).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("a single short batch is NOT mis-reported as capped", async () => {
    executeMock.mockResolvedValueOnce([]); // 0 < batchSize → short
    const result = await deleteExpiredMemoryEntriesForOrg({
      orgId: "org_a",
      retentionDays: 90,
      batchSize: 10,
      maxBatches: 1,
    });
    expect(result.rowsDeleted).toBe(0);
    expect(result.cappedByMaxBatches).toBe(false);
  });
});

describe("listOrgIdsForRetention", () => {
  it("returns distinct org ids and excludes the system sentinel via the query", async () => {
    executeMock.mockResolvedValueOnce([{ org_id: "org_a" }, { org_id: "org_b" }]);
    const ids = await listOrgIdsForRetention();
    expect(ids).toEqual(["org_a", "org_b"]);
    const [first] = renderedCalls();
    expect(first.sql.toLowerCase()).toContain("distinct");
    expect(first.sql.toLowerCase()).toContain("union");
    // The system sentinel is filtered in-query so it never reaches the loop.
    expect(first.sql).toContain("'system'");
  });
});

describe("soft-deleted workflow purge", () => {
  it("hard-purges tombstoned workflows and children in one atomic statement", async () => {
    executeMock.mockResolvedValueOnce([{ rows_deleted: 2 }]);
    const result = await deleteExpiredSoftDeletedWorkflowsForOrg({ orgId: "org_a", retentionDays: 30 });

    expect(result.rowsDeleted).toBe(2);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [first] = renderedCalls();
    expect(first.sql.toLowerCase()).toContain("with expired_workflows as");
    expect(first.sql.toLowerCase()).toContain("deleted_versions as");
    expect(first.sql.toLowerCase()).toContain("deleted_metadata as");
    expect(first.sql.toLowerCase()).toContain("deleted_workflows as");
    expect(first.sql).toContain("deleted_at");
    expect(first.sql).toContain("::timestamptz");
    expect(first.params).toContain("org_a");
  });
});

describe("export-before-delete seam", () => {
  it("returns false when no exporter is registered (default: no archive step)", async () => {
    const ran = await runRetentionExport({ orgId: "org_a", tables: ["audit_logs"] });
    expect(ran).toBe(false);
  });

  it("invokes the registered exporter with the request and returns true", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    setRetentionExporter(spy);
    const ran = await runRetentionExport({
      orgId: "org_a",
      tables: ["run_events", "audit_logs"],
      requestedBy: "user_1",
    });
    expect(ran).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      orgId: "org_a",
      tables: ["run_events", "audit_logs"],
      requestedBy: "user_1",
    });
  });

  it("never throws when the exporter rejects — returns false so the purge still proceeds", async () => {
    setRetentionExporter(vi.fn().mockRejectedValue(new Error("s3 down")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(runRetentionExport({ orgId: "org_a", tables: ["audit_logs"] })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
