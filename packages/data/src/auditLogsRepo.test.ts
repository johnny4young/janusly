/**
 * Tests for the audit_logs retention helper. Mocks `db.execute` so no
 * real database is hit; verifies the batching loop's exit conditions,
 * the runaway cap, and the timing accounting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
  },
  auditLogs: { id: "id", createdAt: "created_at" },
}));

import {
  DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE,
  deleteExpiredAuditLogs,
} from "./auditLogsRepo";

beforeEach(() => {
  dbExecute.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Build N pseudo-row results to simulate a batched DELETE-RETURNING.
 * Postgres-js returns the rows as an array-like RowList; the helper
 * uses `.length` so any array shape with the right cardinality works.
 */
function fakeBatch(rowCount: number): Array<{ id: string }> {
  return Array.from({ length: rowCount }, (_, i) => ({ id: `row-${i}` }));
}

describe("deleteExpiredAuditLogs", () => {
  it("exits after one iteration when the first batch is empty (no expired rows)", async () => {
    dbExecute.mockResolvedValueOnce(fakeBatch(0));
    const result = await deleteExpiredAuditLogs({ retentionDays: 730 });
    expect(result.rowsDeleted).toBe(0);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(typeof result.cutoffAt).toBe("string");
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("exits after one iteration when the first batch returns fewer than batchSize", async () => {
    dbExecute.mockResolvedValueOnce(fakeBatch(5_000));
    const result = await deleteExpiredAuditLogs({ retentionDays: 730 });
    expect(result.rowsDeleted).toBe(5_000);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("loops through multiple full batches and exits on the first short batch", async () => {
    dbExecute
      .mockResolvedValueOnce(fakeBatch(DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE))
      .mockResolvedValueOnce(fakeBatch(DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE))
      .mockResolvedValueOnce(fakeBatch(3_000));
    const result = await deleteExpiredAuditLogs({ retentionDays: 730 });
    expect(result.rowsDeleted).toBe(DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE * 2 + 3_000);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(3);
  });

  it("trips the runaway-safety cap when every batch returns the full batchSize", async () => {
    // Use a small maxBatches so the test stays fast and the assertion
    // is exact (the production default is 1k batches).
    const maxBatches = 5;
    const batchSize = 100;
    for (let i = 0; i < maxBatches; i += 1) {
      dbExecute.mockResolvedValueOnce(fakeBatch(batchSize));
    }
    const result = await deleteExpiredAuditLogs({ retentionDays: 0, batchSize, maxBatches });
    expect(result.rowsDeleted).toBe(maxBatches * batchSize);
    expect(result.cappedByMaxBatches).toBe(true);
    expect(dbExecute).toHaveBeenCalledTimes(maxBatches);
  });

  it("produces a monotonic runtimeMs measurement", async () => {
    dbExecute.mockImplementationOnce(async () => {
      // Force a tiny async tick so the wallclock advances by at least 1ms
      // on most platforms.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeBatch(0);
    });
    const result = await deleteExpiredAuditLogs({ retentionDays: 730 });
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
    // Cap is loose — CI clocks are noisy — but should be < 1s for an
    // empty mocked round-trip.
    expect(result.runtimeMs).toBeLessThan(1_000);
  });
});
