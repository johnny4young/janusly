/**
 * Tests for the SCIM processed-events retention helper. Mocks
 * `db.execute` so no real database is hit; verifies the batching
 * loop's exit conditions, the runaway cap, and timing accounting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
  },
  scimProcessedEvents: { eventId: "event_id", processedAt: "processed_at" },
}));

import {
  DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE,
  pruneOldProcessedEvents,
} from "./scimProcessedEventsRepo";

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
function fakeBatch(rowCount: number): Array<{ event_id: string }> {
  return Array.from({ length: rowCount }, (_, i) => ({ event_id: `event-${i}` }));
}

describe("pruneOldProcessedEvents", () => {
  it("exits after one iteration when the first batch is empty (no expired rows)", async () => {
    dbExecute.mockResolvedValueOnce(fakeBatch(0));
    const result = await pruneOldProcessedEvents({ olderThan: new Date("2026-01-01T00:00:00.000Z") });
    expect(result.rowsDeleted).toBe(0);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(result.cutoffAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("exits after one iteration when the first batch returns fewer than batchSize", async () => {
    dbExecute.mockResolvedValueOnce(fakeBatch(5_000));
    const result = await pruneOldProcessedEvents({ olderThan: new Date("2026-01-01T00:00:00.000Z") });
    expect(result.rowsDeleted).toBe(5_000);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("loops through multiple full batches and exits on the first short batch", async () => {
    dbExecute
      .mockResolvedValueOnce(fakeBatch(DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE))
      .mockResolvedValueOnce(fakeBatch(DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE))
      .mockResolvedValueOnce(fakeBatch(3_000));
    const result = await pruneOldProcessedEvents({ olderThan: new Date("2026-01-01T00:00:00.000Z") });
    expect(result.rowsDeleted).toBe(DEFAULT_SCIM_EVENTS_PRUNE_BATCH_SIZE * 2 + 3_000);
    expect(result.cappedByMaxBatches).toBe(false);
    expect(dbExecute).toHaveBeenCalledTimes(3);
  });

  it("trips the runaway-safety cap when every batch returns the full batchSize", async () => {
    const maxBatches = 5;
    const batchSize = 100;
    for (let i = 0; i < maxBatches; i += 1) {
      dbExecute.mockResolvedValueOnce(fakeBatch(batchSize));
    }
    const result = await pruneOldProcessedEvents({
      olderThan: new Date("2026-01-01T00:00:00.000Z"),
      batchSize,
      maxBatches,
    });
    expect(result.rowsDeleted).toBe(maxBatches * batchSize);
    expect(result.cappedByMaxBatches).toBe(true);
    expect(dbExecute).toHaveBeenCalledTimes(maxBatches);
  });

  it("produces a monotonic runtimeMs measurement", async () => {
    dbExecute.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeBatch(0);
    });
    const result = await pruneOldProcessedEvents({ olderThan: new Date("2026-01-01T00:00:00.000Z") });
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(result.runtimeMs).toBeLessThan(1_000);
  });
});
