/**
 * Pure-unit tests for the auto-healing watcher. Covers the four
 * terminal outcomes: validated (succeeded + signature gone), validated
 * + auto-apply branch, validation_failed with reason signature_changed,
 * and stuck row swept by `sweepStaleValidating`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  selectFromMock: vi.fn(),
  upsertJobSchedulerMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({ from: hoisted.selectFromMock })),
  },
  runs: { id: "id", orgId: "org_id", status: "status", inputJson: "input_json" },
  runNodes: { runId: "run_id", status: "status", nodeId: "node_id", errorJson: "error_json" },
}));

vi.mock("./auto-healing-queue", () => ({
  autoHealingQueue: { upsertJobScheduler: hoisted.upsertJobSchedulerMock },
}));

vi.mock("@janusly/data/src/autoHealingRepo", () => ({
  countRecentAttemptsBySignature: vi.fn(),
  listValidatingRows: vi.fn(),
  recordValidationOutcome: vi.fn(),
  sweepStaleValidating: vi.fn(),
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
}));

vi.mock("./auto-healing-consent", () => ({
  isAutoApplyAllowed: vi.fn(),
  isAutoHealingAllowed: vi.fn(),
}));

vi.mock("./auto-healing-apply", () => ({
  applyValidatedAutoHealing: vi.fn(),
  repairAutoHealingPublications: vi.fn(),
}));

import {
  AUTO_HEALING_WATCH_JOB_NAME,
  DEFAULT_AUTO_HEALING_WATCH_CRON,
  handleAutoHealingWatchTrigger,
  registerAutoHealingWatcherScheduler,
} from "./auto-healing-watcher";
import {
  listValidatingRows,
  recordValidationOutcome,
  sweepStaleValidating,
  countRecentAttemptsBySignature,
} from "@janusly/data/src/autoHealingRepo";
import {
  applyValidatedAutoHealing,
  repairAutoHealingPublications,
} from "./auto-healing-apply";
import {
  isAutoApplyAllowed,
  isAutoHealingAllowed,
} from "./auto-healing-consent";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";

const upsertJobSchedulerMock = hoisted.upsertJobSchedulerMock;
const selectFromMock = hoisted.selectFromMock;
const listMock = vi.mocked(listValidatingRows);
const sweepMock = vi.mocked(sweepStaleValidating);
const outcomeMock = vi.mocked(recordValidationOutcome);
const applyMock = vi.mocked(applyValidatedAutoHealing);
const repairMock = vi.mocked(repairAutoHealingPublications);
const isAutoHealingAllowedMock = vi.mocked(isAutoHealingAllowed);
const isAutoApplyAllowedMock = vi.mocked(isAutoApplyAllowed);
const snapshotMock = vi.mocked(getOrgConfigSnapshot);
const countMock = vi.mocked(countRecentAttemptsBySignature);

function fakeRow(overrides: Partial<{ status: string; signature: string; validationRunId: string; proposedPatchJson: unknown }> = {}) {
  return {
    id: "row-1",
    orgId: "org-1",
    deadLetterId: "dlq-1",
    signature: overrides.signature ?? "HTTP 500 on http node",
    status: "validating",
    proposedPatchJson: overrides.proposedPatchJson ?? null,
    approachLabel: "fix_url",
    confidence: 85,
    validationRunId: overrides.validationRunId ?? "vr-1",
  validationSignature: null,
  decisionActor: null,
  publicationReceipt: null,
  publicationRepairAfter: null,
  publicationAttempts: 0,
    declineReason: null,
    loopAttemptCount: 0,
    metadata: null,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
  } as never;
}

function mockTerminalRunStatus(
  status: string,
  validationEvidenceLevel = "static",
) {
  // db.select for the validation-run terminal-status lookup: .from(runs).where(inArray)
  const where = vi.fn().mockResolvedValue([{
    id: "vr-1",
    orgId: "org-1",
    status,
    inputJson: null,
    validationEvidenceLevel,
  }]);
  selectFromMock.mockReturnValueOnce({ where });
  return where;
}

beforeEach(() => {
  selectFromMock.mockReset();
  upsertJobSchedulerMock.mockReset().mockResolvedValue(undefined);
  listMock.mockReset().mockResolvedValue([]);
  sweepMock.mockReset().mockResolvedValue(0);
  outcomeMock.mockReset();
  applyMock.mockReset().mockResolvedValue({
    outcome: "applied",
    row: fakeRow(),
    receipt: "receipt-1",
  });
  repairMock.mockReset().mockResolvedValue({
    scanned: 0,
    applied: 0,
    pending: 0,
    failed: 0,
  });
  isAutoHealingAllowedMock.mockReset().mockResolvedValue({ allowed: true });
  isAutoApplyAllowedMock.mockReset().mockResolvedValue({ allowed: false, reason: "process_disabled", message: "" });
  snapshotMock.mockReset().mockResolvedValue({
    autoHealing: { enabled: true, autoApply: false, maxAttemptsPerSignature: 3, loopWindowDays: 14 },
  } as never);
  countMock.mockReset().mockResolvedValue(0);
});

describe("registerAutoHealingWatcherScheduler", () => {
  it("registers the default 1-minute cron when env is empty", async () => {
    await expect(registerAutoHealingWatcherScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      "system:auto-healing-watcher",
      { pattern: DEFAULT_AUTO_HEALING_WATCH_CRON },
      { name: AUTO_HEALING_WATCH_JOB_NAME, data: {} },
    );
  });
});

describe("handleAutoHealingWatchTrigger", () => {
  it("records 'validated' when the validation sandbox terminal status is succeeded", async () => {
    listMock.mockResolvedValueOnce([fakeRow()]);
    mockTerminalRunStatus("succeeded");

    await handleAutoHealingWatchTrigger();

    expect(outcomeMock).toHaveBeenCalledWith("row-1", expect.objectContaining({
      outcome: "validated",
    }));
  });

  it("delegates an eligible auto-apply to the durable publication service", async () => {
    listMock.mockResolvedValueOnce([fakeRow({
      proposedPatchJson: {
        id: "wf-1",
        name: "Workflow",
        nodes: [{ id: "n-1", type: "noop", config: {} }],
        edges: [],
      },
    })]);
    mockTerminalRunStatus("succeeded", "provider_simulated");
    isAutoApplyAllowedMock.mockResolvedValueOnce({ allowed: true });

    await handleAutoHealingWatchTrigger();

    expect(applyMock).toHaveBeenCalledWith({
      orgId: "org-1",
      id: "row-1",
      authority: {
        kind: "autonomous",
        actor: "system:auto-healing",
      },
    });
  });

  it("does not auto-apply when validation skipped external writes", async () => {
    listMock.mockResolvedValueOnce([fakeRow({
      proposedPatchJson: {
        id: "wf-1",
        name: "Workflow",
        nodes: [{ id: "n-1", type: "noop", config: {} }],
        edges: [],
      },
    })]);
    mockTerminalRunStatus("succeeded", "writes_skipped");
    isAutoApplyAllowedMock.mockResolvedValueOnce({ allowed: true });

    await handleAutoHealingWatchTrigger();

    expect(outcomeMock).toHaveBeenCalledWith("row-1", expect.objectContaining({
      outcome: "validated",
      validationEvidenceLevel: "writes_skipped",
    }));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("skips rows whose validation run belongs to another org", async () => {
    listMock.mockResolvedValueOnce([fakeRow()]);
    const where = vi.fn().mockResolvedValue([
      { id: "vr-1", orgId: "org-other", status: "succeeded", inputJson: null },
    ]);
    selectFromMock.mockReturnValueOnce({ where });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handleAutoHealingWatchTrigger();
      expect(outcomeMock).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("records 'validation_failed' when the sandbox failed with the same signature", async () => {
    listMock.mockResolvedValueOnce([fakeRow()]);
    mockTerminalRunStatus("failed");
    // computeValidationFailureSignature: chained .where().limit() resolves to no failed node → signature null
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    selectFromMock.mockReturnValueOnce({ where } as never);

    await handleAutoHealingWatchTrigger();

    expect(outcomeMock).toHaveBeenCalledWith("row-1", expect.objectContaining({
      outcome: "validation_failed",
      reason: "validation_failed",
    }));
  });

  it("records 'validation_failed' with reason signature_changed when the new signature differs", async () => {
    listMock.mockResolvedValueOnce([fakeRow()]);
    mockTerminalRunStatus("failed");
    // computeValidationFailureSignature: returns a different errorJson via chained .limit()
    const limit = vi.fn().mockResolvedValue([
      { nodeId: "n-1", errorJson: { code: "ECONNREFUSED", nodeType: "http" } },
    ]);
    const where = vi.fn(() => ({ limit }));
    selectFromMock.mockReturnValueOnce({ where } as never);

    await handleAutoHealingWatchTrigger();

    const call = outcomeMock.mock.calls[0];
    expect(call?.[1]).toMatchObject({ outcome: "validation_failed" });
    expect((call![1] as { reason: string }).reason).toBe("signature_changed");
  });

  it("invokes the stale sweep at the start of every tick", async () => {
    sweepMock.mockResolvedValueOnce(7);
    listMock.mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleAutoHealingWatchTrigger();
      expect(sweepMock).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/swept 7 stale/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("repairs expired publication leases before scanning validation rows", async () => {
    repairMock.mockResolvedValueOnce({
      scanned: 1,
      applied: 1,
      pending: 0,
      failed: 0,
    });
    listMock.mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleAutoHealingWatchTrigger();
      expect(repairMock).toHaveBeenCalledTimes(1);
      expect(sweepMock).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});
