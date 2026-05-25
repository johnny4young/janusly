/**
 * Tests for the daily audit-logs retention sweep scheduler. Mocks
 * `./queue` (no real Redis), `@janusly/data/src/auditLogsRepo` (no
 * DB), and `@janusly/db` (the system-sentinel audit insert path).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesMock = vi.fn();

vi.mock("./queue", () => ({
  workflowQueue: {
    upsertJobScheduler: vi.fn(),
  },
}));

vi.mock("@janusly/data/src/auditLogsRepo", () => ({
  deleteExpiredAuditLogs: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
  },
  auditLogs: { id: "id" },
}));

import { deleteExpiredAuditLogs } from "@janusly/data/src/auditLogsRepo";

import {
  AUDIT_LOGS_RETENTION_JOB_ID,
  AUDIT_LOGS_RETENTION_JOB_NAME,
  DEFAULT_AUDIT_LOGS_RETENTION_CRON,
  DEFAULT_AUDIT_LOGS_RETENTION_DAYS,
  handleAuditLogsRetentionTrigger,
  MAX_AUDIT_LOGS_RETENTION_DAYS,
  MIN_AUDIT_LOGS_RETENTION_DAYS,
  registerAuditLogsRetentionScheduler,
  resolveAuditLogsRetentionDays,
} from "./audit-logs-retention-scheduler";
import { workflowQueue } from "./queue";

const upsertJobSchedulerMock = vi.mocked(workflowQueue.upsertJobScheduler);
const deleteExpiredAuditLogsMock = vi.mocked(deleteExpiredAuditLogs);

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  upsertJobSchedulerMock.mockResolvedValue(undefined as never);
  deleteExpiredAuditLogsMock.mockReset();
  deleteExpiredAuditLogsMock.mockResolvedValue({
    rowsDeleted: 0,
    cutoffAt: new Date().toISOString(),
    runtimeMs: 1,
    cappedByMaxBatches: false,
  });
  insertValuesMock.mockReset().mockResolvedValue(undefined);
});

describe("registerAuditLogsRetentionScheduler", () => {
  it("registers the daily default cron when env is empty", async () => {
    await expect(registerAuditLogsRetentionScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      AUDIT_LOGS_RETENTION_JOB_ID,
      { pattern: DEFAULT_AUDIT_LOGS_RETENTION_CRON },
      { name: AUDIT_LOGS_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("respects the env override when JANUSLY_AUDIT_LOGS_RETENTION_CRON is set", async () => {
    await registerAuditLogsRetentionScheduler({ JANUSLY_AUDIT_LOGS_RETENTION_CRON: "0 5 * * *" });
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      AUDIT_LOGS_RETENTION_JOB_ID,
      { pattern: "0 5 * * *" },
      { name: AUDIT_LOGS_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("warn-falls-back to the default cron on parse failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registerAuditLogsRetentionScheduler({ JANUSLY_AUDIT_LOGS_RETENTION_CRON: "not-a-cron" });
      expect(warn.mock.calls[0]?.[0]).toMatch(/JANUSLY_AUDIT_LOGS_RETENTION_CRON invalid/);
      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        AUDIT_LOGS_RETENTION_JOB_ID,
        { pattern: DEFAULT_AUDIT_LOGS_RETENTION_CRON },
        { name: AUDIT_LOGS_RETENTION_JOB_NAME, data: {} },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws when upsertJobScheduler rejects (boot-resilient)", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registerAuditLogsRetentionScheduler({})).resolves.toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("resolveAuditLogsRetentionDays", () => {
  it("returns default when env is empty", () => {
    expect(resolveAuditLogsRetentionDays({})).toBe(DEFAULT_AUDIT_LOGS_RETENTION_DAYS);
  });

  it("accepts an in-range integer", () => {
    expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: "365" })).toBe(365);
  });

  it("warn-falls-back when env is non-numeric", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: "forever" })).toBe(DEFAULT_AUDIT_LOGS_RETENTION_DAYS);
      expect(warn.mock.calls[0]?.[0]).toMatch(/is not an integer/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warn-falls-back when env is below the floor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: "5" })).toBe(DEFAULT_AUDIT_LOGS_RETENTION_DAYS);
      expect(warn.mock.calls[0]?.[0]).toMatch(/out of range/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warn-falls-back when env exceeds the ceiling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: String(MAX_AUDIT_LOGS_RETENTION_DAYS + 1) })).toBe(DEFAULT_AUDIT_LOGS_RETENTION_DAYS);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the floor and ceiling exactly", () => {
    expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: String(MIN_AUDIT_LOGS_RETENTION_DAYS) })).toBe(MIN_AUDIT_LOGS_RETENTION_DAYS);
    expect(resolveAuditLogsRetentionDays({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: String(MAX_AUDIT_LOGS_RETENTION_DAYS) })).toBe(MAX_AUDIT_LOGS_RETENTION_DAYS);
  });
});

describe("handleAuditLogsRetentionTrigger", () => {
  it("calls deleteExpiredAuditLogs with the resolved retention window and audits the outcome", async () => {
    deleteExpiredAuditLogsMock.mockResolvedValueOnce({
      rowsDeleted: 42,
      cutoffAt: "2024-05-26T00:00:00.000Z",
      runtimeMs: 1234,
      cappedByMaxBatches: false,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleAuditLogsRetentionTrigger({ JANUSLY_AUDIT_LOGS_RETENTION_DAYS: "365" });
      expect(deleteExpiredAuditLogsMock).toHaveBeenCalledWith({ retentionDays: 365 });
      expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "system",
        userId: null,
        action: "audit_logs.retention.purged",
        metadata: expect.objectContaining({
          rowsDeleted: 42,
          cutoffAt: "2024-05-26T00:00:00.000Z",
          runtimeMs: 1234,
          retentionDays: 365,
          cappedByMaxBatches: false,
        }),
      }));
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/purged 42 rows/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never throws when deleteExpiredAuditLogs rejects (BullMQ retry storm guard)", async () => {
    deleteExpiredAuditLogsMock.mockRejectedValueOnce(new Error("postgres unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleAuditLogsRetentionTrigger({})).resolves.toBeUndefined();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/sweep failed/);
      expect(insertValuesMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
