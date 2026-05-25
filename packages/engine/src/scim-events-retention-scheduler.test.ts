/**
 * Tests for the daily scim-events retention sweep scheduler. Mocks
 * `./queue` (no real Redis), `@janusly/data/src/scimProcessedEventsRepo`
 * (no DB), and `@janusly/db` (the system-sentinel audit insert path).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesMock = vi.fn();

vi.mock("./queue", () => ({
  workflowQueue: {
    upsertJobScheduler: vi.fn(),
  },
}));

vi.mock("@janusly/data/src/scimProcessedEventsRepo", () => ({
  pruneOldProcessedEvents: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
  },
  auditLogs: { id: "id" },
}));

import { pruneOldProcessedEvents } from "@janusly/data/src/scimProcessedEventsRepo";

import {
  DEFAULT_SCIM_EVENTS_RETENTION_CRON,
  DEFAULT_SCIM_EVENTS_RETENTION_DAYS,
  handleScimEventsRetentionTrigger,
  MAX_SCIM_EVENTS_RETENTION_DAYS,
  MIN_SCIM_EVENTS_RETENTION_DAYS,
  registerScimEventsRetentionScheduler,
  resolveScimEventsRetentionDays,
  SCIM_EVENTS_RETENTION_JOB_ID,
  SCIM_EVENTS_RETENTION_JOB_NAME,
} from "./scim-events-retention-scheduler";
import { workflowQueue } from "./queue";

const upsertJobSchedulerMock = vi.mocked(workflowQueue.upsertJobScheduler);
const pruneOldProcessedEventsMock = vi.mocked(pruneOldProcessedEvents);

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  upsertJobSchedulerMock.mockResolvedValue(undefined as never);
  pruneOldProcessedEventsMock.mockReset();
  pruneOldProcessedEventsMock.mockResolvedValue({
    rowsDeleted: 0,
    cutoffAt: new Date().toISOString(),
    runtimeMs: 1,
    cappedByMaxBatches: false,
  });
  insertValuesMock.mockReset().mockResolvedValue(undefined);
});

describe("registerScimEventsRetentionScheduler", () => {
  it("registers the daily default cron when env is empty", async () => {
    await expect(registerScimEventsRetentionScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      SCIM_EVENTS_RETENTION_JOB_ID,
      { pattern: DEFAULT_SCIM_EVENTS_RETENTION_CRON },
      { name: SCIM_EVENTS_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("respects the env override when JANUSLY_SCIM_EVENTS_RETENTION_CRON is set", async () => {
    await registerScimEventsRetentionScheduler({ JANUSLY_SCIM_EVENTS_RETENTION_CRON: "0 5 * * *" });
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      SCIM_EVENTS_RETENTION_JOB_ID,
      { pattern: "0 5 * * *" },
      { name: SCIM_EVENTS_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("warn-falls-back to the default cron on parse failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registerScimEventsRetentionScheduler({ JANUSLY_SCIM_EVENTS_RETENTION_CRON: "not-a-cron" });
      expect(warn.mock.calls[0]?.[0]).toMatch(/JANUSLY_SCIM_EVENTS_RETENTION_CRON invalid/);
      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        SCIM_EVENTS_RETENTION_JOB_ID,
        { pattern: DEFAULT_SCIM_EVENTS_RETENTION_CRON },
        { name: SCIM_EVENTS_RETENTION_JOB_NAME, data: {} },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws when upsertJobScheduler rejects (boot-resilient)", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registerScimEventsRetentionScheduler({})).resolves.toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("resolveScimEventsRetentionDays", () => {
  it("returns default when env is empty", () => {
    expect(resolveScimEventsRetentionDays({})).toBe(DEFAULT_SCIM_EVENTS_RETENTION_DAYS);
  });

  it("accepts an in-range integer", () => {
    expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: "30" })).toBe(30);
  });

  it("warn-falls-back when env is non-numeric", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: "forever" })).toBe(DEFAULT_SCIM_EVENTS_RETENTION_DAYS);
      expect(warn.mock.calls[0]?.[0]).toMatch(/is not an integer/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warn-falls-back when env is below the floor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: "3" })).toBe(DEFAULT_SCIM_EVENTS_RETENTION_DAYS);
      expect(warn.mock.calls[0]?.[0]).toMatch(/out of range/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warn-falls-back when env exceeds the ceiling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: String(MAX_SCIM_EVENTS_RETENTION_DAYS + 1) })).toBe(DEFAULT_SCIM_EVENTS_RETENTION_DAYS);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the floor and ceiling exactly", () => {
    expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: String(MIN_SCIM_EVENTS_RETENTION_DAYS) })).toBe(MIN_SCIM_EVENTS_RETENTION_DAYS);
    expect(resolveScimEventsRetentionDays({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: String(MAX_SCIM_EVENTS_RETENTION_DAYS) })).toBe(MAX_SCIM_EVENTS_RETENTION_DAYS);
  });
});

describe("handleScimEventsRetentionTrigger", () => {
  it("calls pruneOldProcessedEvents with the resolved cutoff and audits the outcome", async () => {
    pruneOldProcessedEventsMock.mockResolvedValueOnce({
      rowsDeleted: 17,
      cutoffAt: "2024-05-26T00:00:00.000Z",
      runtimeMs: 200,
      cappedByMaxBatches: false,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleScimEventsRetentionTrigger({ JANUSLY_SCIM_EVENTS_RETENTION_DAYS: "60" });
      expect(pruneOldProcessedEventsMock).toHaveBeenCalledTimes(1);
      const call = pruneOldProcessedEventsMock.mock.calls[0]?.[0];
      expect(call?.olderThan).toBeInstanceOf(Date);
      // olderThan = now - 60 days; verify it's in the right ballpark.
      const ageMs = Date.now() - (call?.olderThan?.getTime() ?? 0);
      const expectedMs = 60 * 24 * 60 * 60 * 1000;
      expect(Math.abs(ageMs - expectedMs)).toBeLessThan(5_000);
      expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "system",
        userId: null,
        action: "scim.event_log.retention.purged",
        metadata: expect.objectContaining({
          rowsDeleted: 17,
          retentionDays: 60,
          cappedByMaxBatches: false,
        }),
      }));
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/purged 17 rows/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never throws when pruneOldProcessedEvents rejects", async () => {
    pruneOldProcessedEventsMock.mockRejectedValueOnce(new Error("postgres unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleScimEventsRetentionTrigger({})).resolves.toBeUndefined();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/sweep failed/);
      expect(insertValuesMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
