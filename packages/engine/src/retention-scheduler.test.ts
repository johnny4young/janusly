/**
 * Pure-unit tests for the daily per-org retention sweep scheduler.
 *
 * Mocks `./queue` (no real Redis / BullMQ), `@janusly/db` (no DB for the
 * per-org audit insert), and `@janusly/data` (the repo helpers + config
 * reader + export seam). Covers AC cases:
 *   - retention job bounds (default cron / env override / malformed warn-fallback)
 *   - reads per-org config bounds and passes them to each table purge
 *   - export-before-delete runs BEFORE the purge
 *   - cross-org isolation: each org swept independently, one audit row per org
 *   - never-throws posture (per-org failure does not abort the loop)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RetentionAuditInput = {
  orgId: string;
  actor?: string | null;
  action: string;
  metadata: {
    totalRowsDeleted: number;
    tables: unknown[];
  };
};

vi.mock("./queue", () => ({
  maintenanceQueue: { upsertJobScheduler: vi.fn() },
}));

const auditInsertValuesMock = vi.fn();
const recordSystemAuditMock = vi.hoisted(() => vi.fn(async (_input: RetentionAuditInput) => undefined));
vi.mock("@janusly/db", () => ({
  db: { insert: vi.fn(() => ({ values: auditInsertValuesMock })) },
  auditLogs: { id: "id_col" },
}));

vi.mock("@janusly/data", () => ({
  recordSystemAudit: recordSystemAuditMock,
  listOrgIdsForRetention: vi.fn(),
  getRetentionPolicyConfig: vi.fn(),
  runRetentionExport: vi.fn(),
  deleteExpiredRunEventsForOrg: vi.fn(),
  deleteExpiredAuditLogsForOrg: vi.fn(),
  deleteExpiredUsageEventsForOrg: vi.fn(),
  deleteExpiredRecoveryFeedbackForOrg: vi.fn(),
  deleteExpiredMemoryEntriesForOrg: vi.fn(),
  deleteExpiredSoftDeletedWorkflowsForOrg: vi.fn(),
}));

import {
  deleteExpiredAuditLogsForOrg,
  deleteExpiredMemoryEntriesForOrg,
  deleteExpiredRecoveryFeedbackForOrg,
  deleteExpiredRunEventsForOrg,
  deleteExpiredSoftDeletedWorkflowsForOrg,
  deleteExpiredUsageEventsForOrg,
  getRetentionPolicyConfig,
  listOrgIdsForRetention,
  runRetentionExport,
} from "@janusly/data";

import {
  DEFAULT_RETENTION_CRON,
  handleRetentionTrigger,
  purgeRetentionForOrg,
  RETENTION_JOB_ID,
  RETENTION_JOB_NAME,
  registerRetentionScheduler,
} from "./retention-scheduler";
import { maintenanceQueue } from "./queue";

const upsertJobSchedulerMock = vi.mocked(maintenanceQueue.upsertJobScheduler);
const listOrgIdsMock = vi.mocked(listOrgIdsForRetention);
const getConfigMock = vi.mocked(getRetentionPolicyConfig);
const exportMock = vi.mocked(runRetentionExport);
const runEventsPurgeMock = vi.mocked(deleteExpiredRunEventsForOrg);
const auditLogsPurgeMock = vi.mocked(deleteExpiredAuditLogsForOrg);
const usageEventsPurgeMock = vi.mocked(deleteExpiredUsageEventsForOrg);
const recoveryFeedbackPurgeMock = vi.mocked(deleteExpiredRecoveryFeedbackForOrg);
const memoryEntriesPurgeMock = vi.mocked(deleteExpiredMemoryEntriesForOrg);
const softDeletedWorkflowsPurgeMock = vi.mocked(deleteExpiredSoftDeletedWorkflowsForOrg);

const DEFAULT_POLICY = {
  runEventsDays: 90,
  auditLogsDays: 365,
  usageEventsDays: 90,
  recoveryFeedbackDays: 180,
  memoryEntriesDays: 90,
  deletedWorkflowsDays: 30,
};

function purgeResult(rowsDeleted: number) {
  return { rowsDeleted, cutoffAt: "2020-01-01T00:00:00.000Z", runtimeMs: 1, cappedByMaxBatches: false };
}

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  upsertJobSchedulerMock.mockResolvedValue(undefined as never);
  auditInsertValuesMock.mockReset();
  auditInsertValuesMock.mockResolvedValue(undefined);
  recordSystemAuditMock.mockReset();
  recordSystemAuditMock.mockResolvedValue(undefined);
  listOrgIdsMock.mockReset();
  getConfigMock.mockReset();
  getConfigMock.mockResolvedValue({ ...DEFAULT_POLICY });
  exportMock.mockReset();
  exportMock.mockResolvedValue(false);
  for (const m of [runEventsPurgeMock, auditLogsPurgeMock, usageEventsPurgeMock, recoveryFeedbackPurgeMock, memoryEntriesPurgeMock, softDeletedWorkflowsPurgeMock]) {
    m.mockReset();
    m.mockResolvedValue(purgeResult(0));
  }
});

describe("registerRetentionScheduler", () => {
  it("registers the daily default cron when env is empty", async () => {
    await expect(registerRetentionScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      RETENTION_JOB_ID,
      { pattern: DEFAULT_RETENTION_CRON },
      { name: RETENTION_JOB_NAME, data: {} },
    );
  });

  it("respects the env override when JANUSLY_RETENTION_CRON is set", async () => {
    await expect(registerRetentionScheduler({ JANUSLY_RETENTION_CRON: "30 1 * * *" })).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      RETENTION_JOB_ID,
      { pattern: "30 1 * * *" },
      { name: RETENTION_JOB_NAME, data: {} },
    );
  });

  it("warn-logs and falls back to the default on a malformed cron", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(registerRetentionScheduler({ JANUSLY_RETENTION_CRON: "nope" })).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/JANUSLY_RETENTION_CRON invalid/);
      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        RETENTION_JOB_ID,
        { pattern: DEFAULT_RETENTION_CRON },
        { name: RETENTION_JOB_NAME, data: {} },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws when upsertJobScheduler rejects (boot-resilient)", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registerRetentionScheduler({})).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("purgeRetentionForOrg — per-org bounds + ordering", () => {
  it("passes each table its configured retention days from the org's policy", async () => {
    getConfigMock.mockResolvedValueOnce({
      runEventsDays: 7,
      auditLogsDays: 730,
      usageEventsDays: 30,
      recoveryFeedbackDays: 45,
      memoryEntriesDays: 15,
      deletedWorkflowsDays: 5,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await purgeRetentionForOrg("org_a");
    } finally {
      logSpy.mockRestore();
    }
    expect(getConfigMock).toHaveBeenCalledWith("org_a");
    expect(runEventsPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 7 });
    expect(auditLogsPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 730 });
    expect(usageEventsPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 30 });
    expect(recoveryFeedbackPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 45 });
    expect(memoryEntriesPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 15 });
    expect(softDeletedWorkflowsPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 5 });
  });

  it("runs the export seam BEFORE any table purge (export-before-delete)", async () => {
    const order: string[] = [];
    exportMock.mockImplementationOnce(async () => {
      order.push("export");
      return true;
    });
    runEventsPurgeMock.mockImplementationOnce(async () => {
      order.push("purge");
      return purgeResult(0);
    });
    await purgeRetentionForOrg("org_a");
    expect(order[0]).toBe("export");
    expect(order).toContain("purge");
    expect(exportMock).toHaveBeenCalledWith({
      orgId: "org_a",
      tables: ["run_events", "audit_logs", "usage_events", "recovery_feedback", "memory_entries", "workflows"],
      requestedBy: null,
    });
  });

  it("writes exactly one retention.purged audit row scoped to the org with a per-table breakdown", async () => {
    runEventsPurgeMock.mockResolvedValueOnce(purgeResult(5));
    auditLogsPurgeMock.mockResolvedValueOnce(purgeResult(2));
    await purgeRetentionForOrg("org_a");
    expect(recordSystemAuditMock).toHaveBeenCalledTimes(1);
    const row = recordSystemAuditMock.mock.calls[0]?.[0];
    expect(row.orgId).toBe("org_a");
    expect(row.actor ?? null).toBeNull();
    expect(row.action).toBe("retention.purged");
    expect(row.metadata.totalRowsDeleted).toBe(7);
    expect(Array.isArray(row.metadata.tables)).toBe(true);
    expect(row.metadata.tables).toHaveLength(6);
  });

  it("isolates a per-table failure: other tables still purge and the audit still writes", async () => {
    auditLogsPurgeMock.mockRejectedValueOnce(new Error("boom"));
    runEventsPurgeMock.mockResolvedValueOnce(purgeResult(3));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await purgeRetentionForOrg("org_a");
    } finally {
      errorSpy.mockRestore();
    }
    expect(usageEventsPurgeMock).toHaveBeenCalledTimes(1);
    expect(memoryEntriesPurgeMock).toHaveBeenCalledTimes(1);
    expect(recordSystemAuditMock).toHaveBeenCalledTimes(1);
    const row = recordSystemAuditMock.mock.calls[0]?.[0];
    // The failed table contributes 0, the rest are counted.
    expect(row.metadata.totalRowsDeleted).toBe(3);
  });
});

describe("handleRetentionTrigger — cross-org isolation", () => {
  it("sweeps every org independently with its own config + audit row", async () => {
    listOrgIdsMock.mockResolvedValueOnce(["org_a", "org_b"]);
    getConfigMock
      .mockResolvedValueOnce({ ...DEFAULT_POLICY, runEventsDays: 7 })
      .mockResolvedValueOnce({ ...DEFAULT_POLICY, runEventsDays: 365 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleRetentionTrigger();
    } finally {
      logSpy.mockRestore();
    }
    expect(getConfigMock).toHaveBeenCalledWith("org_a");
    expect(getConfigMock).toHaveBeenCalledWith("org_b");
    // org_a got its 7-day window, org_b got its 365-day window.
    expect(runEventsPurgeMock).toHaveBeenCalledWith({ orgId: "org_a", retentionDays: 7 });
    expect(runEventsPurgeMock).toHaveBeenCalledWith({ orgId: "org_b", retentionDays: 365 });
    // One audit row per org.
    const auditedOrgs = recordSystemAuditMock.mock.calls.map((c) => c[0].orgId).sort();
    expect(auditedOrgs).toEqual(["org_a", "org_b"]);
  });

  it("one org's failure does not abort the rest of the loop", async () => {
    listOrgIdsMock.mockResolvedValueOnce(["org_bad", "org_good"]);
    // org_bad: config read throws → purgeRetentionForOrg rejects.
    getConfigMock.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce({ ...DEFAULT_POLICY });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(handleRetentionTrigger()).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    // org_good still swept after org_bad failed.
    expect(getConfigMock).toHaveBeenCalledWith("org_good");
    expect(runEventsPurgeMock).toHaveBeenCalledWith({ orgId: "org_good", retentionDays: 90 });
  });

  it("never throws when org enumeration fails; skips the fire", async () => {
    listOrgIdsMock.mockRejectedValueOnce(new Error("enumerate failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(handleRetentionTrigger()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/failed to enumerate orgs/);
    } finally {
      errorSpy.mockRestore();
    }
    // No org was swept.
    expect(runEventsPurgeMock).not.toHaveBeenCalled();
  });
});
