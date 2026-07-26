/**
 * Pure-unit tests for the daily memory-retention sweep scheduler.
 *
 * Mocks `./queue` (so no real Redis / BullMQ instance is needed) and
 * `@janusly/data/src/memoryEntriesRepo` (so no DB is hit). Asserts:
 *   - default cron when env is empty
 *   - env override when JANUSLY_MEMORY_RETENTION_CRON is set
 *   - malformed env warn-logs + falls back to default (no throw)
 *   - the handler invokes deleteExpiredMemory({}) and never throws
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({
  maintenanceQueue: {
    upsertJobScheduler: vi.fn(),
  },
}));

vi.mock("@janusly/data/src/memoryEntriesRepo", () => ({
  deleteExpiredMemory: vi.fn(),
}));

import { deleteExpiredMemory } from "@janusly/data/src/memoryEntriesRepo";

import {
  DEFAULT_MEMORY_RETENTION_CRON,
  handleMemoryRetentionTrigger,
  MEMORY_RETENTION_JOB_ID,
  MEMORY_RETENTION_JOB_NAME,
  registerMemoryRetentionScheduler,
} from "./memory-retention-scheduler";
import { maintenanceQueue } from "./queue";

const upsertJobSchedulerMock = vi.mocked(maintenanceQueue.upsertJobScheduler);
const deleteExpiredMemoryMock = vi.mocked(deleteExpiredMemory);

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  upsertJobSchedulerMock.mockResolvedValue(undefined as never);
  deleteExpiredMemoryMock.mockReset();
  deleteExpiredMemoryMock.mockResolvedValue({ entriesPurged: 0 });
});

describe("registerMemoryRetentionScheduler", () => {
  it("registers the daily default cron when env is empty", async () => {
    await expect(registerMemoryRetentionScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      MEMORY_RETENTION_JOB_ID,
      { pattern: DEFAULT_MEMORY_RETENTION_CRON },
      { name: MEMORY_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("respects the env override when JANUSLY_MEMORY_RETENTION_CRON is set", async () => {
    await expect(registerMemoryRetentionScheduler({
      JANUSLY_MEMORY_RETENTION_CRON: "*/15 * * * *",
    })).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      MEMORY_RETENTION_JOB_ID,
      { pattern: "*/15 * * * *" },
      { name: MEMORY_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("warn-logs and falls back to the default when env carries a malformed cron", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(registerMemoryRetentionScheduler({
        JANUSLY_MEMORY_RETENTION_CRON: "not-a-cron",
      })).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/JANUSLY_MEMORY_RETENTION_CRON invalid/);
      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        MEMORY_RETENTION_JOB_ID,
        { pattern: DEFAULT_MEMORY_RETENTION_CRON },
        { name: MEMORY_RETENTION_JOB_NAME, data: {} },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws when upsertJobScheduler rejects (boot-resilient)", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registerMemoryRetentionScheduler({})).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("handleMemoryRetentionTrigger", () => {
  it("invokes deleteExpiredMemory with the global-sweep signature ({})", async () => {
    deleteExpiredMemoryMock.mockResolvedValueOnce({ entriesPurged: 42 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleMemoryRetentionTrigger();
      expect(deleteExpiredMemoryMock).toHaveBeenCalledTimes(1);
      expect(deleteExpiredMemoryMock).toHaveBeenCalledWith({});
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/purged 42 entries/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never throws when deleteExpiredMemory rejects (BullMQ retry storm guard)", async () => {
    deleteExpiredMemoryMock.mockRejectedValueOnce(new Error("postgres unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleMemoryRetentionTrigger()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/sweep failed/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
