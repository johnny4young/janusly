/**
 * DB-backed unit tests for `getRetentionPolicyConfig` — the narrow
 * `retention.*` reader on the daily-sweep hot path.
 *
 * `@janusly/db` is mocked so `db.select().from().where()` returns a
 * controllable row set. Asserts catalog defaults when the org has no
 * row, tenant overrides when rows exist, and the read-time clamp that
 * rejects out-of-range / non-numeric stored values back to the default
 * (so the sweep never deletes against a nonsense window).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: whereMock })) })),
  },
  orgConfigs: { orgId: "org_id_col", key: "key_col" },
}));

import { getRetentionPolicyConfig } from "./orgConfigRepo";

beforeEach(() => {
  whereMock.mockReset();
});

const DEFAULTS = {
  runEventsDays: 90,
  auditLogsDays: 365,
  usageEventsDays: 90,
  recoveryFeedbackDays: 180,
  memoryEntriesDays: 90,
  deletedWorkflowsDays: 30,
};

describe("getRetentionPolicyConfig", () => {
  it("returns catalog defaults when the org has no retention rows", async () => {
    whereMock.mockResolvedValueOnce([]);
    await expect(getRetentionPolicyConfig("org_a")).resolves.toEqual(DEFAULTS);
  });

  it("applies tenant overrides from stored rows", async () => {
    whereMock.mockResolvedValueOnce([
      { key: "retention.runEventsDays", valueJson: 7 },
      { key: "retention.auditLogsDays", valueJson: 730 },
      { key: "retention.memoryEntriesDays", valueJson: 30 },
      { key: "retention.deletedWorkflowsDays", valueJson: 7 },
    ]);
    await expect(getRetentionPolicyConfig("org_a")).resolves.toEqual({
      ...DEFAULTS,
      runEventsDays: 7,
      auditLogsDays: 730,
      memoryEntriesDays: 30,
      deletedWorkflowsDays: 7,
    });
  });

  it("clamps an out-of-range stored value back to the catalog default", async () => {
    whereMock.mockResolvedValueOnce([
      { key: "retention.runEventsDays", valueJson: 1 }, // below min 7
      { key: "retention.auditLogsDays", valueJson: 99_999 }, // above max 730
    ]);
    const result = await getRetentionPolicyConfig("org_a");
    expect(result.runEventsDays).toBe(90);
    expect(result.auditLogsDays).toBe(365);
  });

  it("ignores a non-numeric stored value and uses the default", async () => {
    whereMock.mockResolvedValueOnce([
      { key: "retention.usageEventsDays", valueJson: "not-a-number" },
    ]);
    const result = await getRetentionPolicyConfig("org_a");
    expect(result.usageEventsDays).toBe(90);
  });

  it("fails soft to defaults when the DB read throws", async () => {
    whereMock.mockRejectedValueOnce(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getRetentionPolicyConfig("org_a")).resolves.toEqual(DEFAULTS);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
