import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  prune: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("./queue", () => ({ maintenanceQueue: { upsertJobScheduler: mocks.upsert } }));
vi.mock("@janusly/data", () => ({
  pruneIdentityState: mocks.prune,
  recordSystemAudit: mocks.audit,
}));

import {
  DEFAULT_IDENTITY_RETENTION_CRON,
  DEFAULT_IDENTITY_SESSION_RETENTION_DAYS,
  handleIdentityRetentionTrigger,
  IDENTITY_RETENTION_JOB_ID,
  IDENTITY_RETENTION_JOB_NAME,
  registerIdentityRetentionScheduler,
  resolveIdentitySessionRetentionDays,
} from "./identity-retention-scheduler";

beforeEach(() => {
  mocks.upsert.mockReset().mockResolvedValue(undefined);
  mocks.prune.mockReset().mockResolvedValue({
    sessionsDeleted: 2,
    noncesDeleted: 4,
    sessionCutoffAt: "2026-07-15T00:00:00.000Z",
    nonceCutoffAt: "2026-07-22T00:00:00.000Z",
    runtimeMs: 1,
    cappedByMaxBatches: false,
  });
  mocks.audit.mockReset().mockResolvedValue(undefined);
});
describe("identity retention", () => {
  it("registers the default recurring maintenance job", async () => {
    await expect(registerIdentityRetentionScheduler({})).resolves.toBe(true);
    expect(mocks.upsert).toHaveBeenCalledWith(
      IDENTITY_RETENTION_JOB_ID,
      { pattern: DEFAULT_IDENTITY_RETENTION_CRON },
      { name: IDENTITY_RETENTION_JOB_NAME, data: {} },
    );
  });

  it("bounds the stale-session retention window", () => {
    expect(resolveIdentitySessionRetentionDays({})).toBe(DEFAULT_IDENTITY_SESSION_RETENTION_DAYS);
    expect(resolveIdentitySessionRetentionDays({ JANUSLY_IDENTITY_SESSION_RETENTION_DAYS: "30" })).toBe(30);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveIdentitySessionRetentionDays({ JANUSLY_IDENTITY_SESSION_RETENTION_DAYS: "0" }))
      .toBe(DEFAULT_IDENTITY_SESSION_RETENTION_DAYS);
    warn.mockRestore();
  });

  it("purges and records a system audit without exposing rows", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleIdentityRetentionTrigger({ JANUSLY_IDENTITY_SESSION_RETENTION_DAYS: "14" });
    expect(mocks.prune).toHaveBeenCalledWith({ sessionOlderThan: expect.any(Date) });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "system",
      action: "auth.session.retention.purged",
      metadata: expect.objectContaining({ sessionsDeleted: 2, noncesDeleted: 4, retentionDays: 14 }),
    }));
    log.mockRestore();
  });

  it("never throws when persistence is unavailable", async () => {
    mocks.prune.mockRejectedValueOnce(new Error("postgres unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(handleIdentityRetentionTrigger({})).resolves.toBeUndefined();
    expect(mocks.audit).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
