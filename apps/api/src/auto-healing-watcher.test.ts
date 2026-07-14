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
  replayDeadLetterMock: vi.fn(),
  markDeadLetterReplayedMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({ from: hoisted.selectFromMock })),
  },
  deadLetters: { orgId: "org_id", id: "id", runId: "run_id", nodeId: "node_id" },
  runs: { id: "id", orgId: "org_id", status: "status", inputJson: "input_json" },
  runNodes: { runId: "run_id", status: "status", nodeId: "node_id", errorJson: "error_json" },
}));

vi.mock("./auto-healing-queue", () => ({
  autoHealingQueue: { upsertJobScheduler: hoisted.upsertJobSchedulerMock },
}));

vi.mock("@janusly/data/src/autoHealingRepo", () => ({
  countRecentAttemptsBySignature: vi.fn(),
  listValidatingRows: vi.fn(),
  recordDecision: vi.fn(),
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

vi.mock("@janusly/engine/src/adapters/dlq-replay", () => ({
  DLQReplayAdapter: class {
    replayDeadLetter = hoisted.replayDeadLetterMock;
  },
}));

vi.mock("./dlq", () => ({
  markDeadLetterReplayed: hoisted.markDeadLetterReplayedMock,
}));

vi.mock("./audit", () => ({
  audit: vi.fn(),
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
  recordDecision,
  countRecentAttemptsBySignature,
} from "@janusly/data/src/autoHealingRepo";
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
const decisionMock = vi.mocked(recordDecision);
const isAutoHealingAllowedMock = vi.mocked(isAutoHealingAllowed);
const isAutoApplyAllowedMock = vi.mocked(isAutoApplyAllowed);
const snapshotMock = vi.mocked(getOrgConfigSnapshot);
const countMock = vi.mocked(countRecentAttemptsBySignature);
const replayDeadLetterMock = hoisted.replayDeadLetterMock;
const markDeadLetterReplayedMock = hoisted.markDeadLetterReplayedMock;

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
    declineReason: null,
    loopAttemptCount: 0,
    metadata: null,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
  } as never;
}

function mockTerminalRunStatus(status: string) {
  // db.select for the validation-run terminal-status lookup: .from(runs).where(inArray)
  const where = vi.fn().mockResolvedValue([{ id: "vr-1", orgId: "org-1", status, inputJson: null }]);
  selectFromMock.mockReturnValueOnce({ where });
  return where;
}

beforeEach(() => {
  selectFromMock.mockReset();
  upsertJobSchedulerMock.mockReset().mockResolvedValue(undefined);
  listMock.mockReset().mockResolvedValue([]);
  sweepMock.mockReset().mockResolvedValue(0);
  outcomeMock.mockReset();
  decisionMock.mockReset().mockResolvedValue({ applied: true });
  isAutoHealingAllowedMock.mockReset().mockResolvedValue({ allowed: true });
  isAutoApplyAllowedMock.mockReset().mockResolvedValue({ allowed: false, reason: "process_disabled", message: "" });
  snapshotMock.mockReset().mockResolvedValue({
    autoHealing: { enabled: true, autoApply: false, maxAttemptsPerSignature: 3, loopWindowDays: 14 },
  } as never);
  countMock.mockReset().mockResolvedValue(0);
  replayDeadLetterMock.mockReset().mockResolvedValue(undefined);
  markDeadLetterReplayedMock.mockReset().mockResolvedValue(undefined);
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

  it("attributes an auto-applied replay and marks the DLQ row after enqueue", async () => {
    listMock.mockResolvedValueOnce([fakeRow({
      proposedPatchJson: {
        id: "wf-1",
        name: "Workflow",
        nodes: [{ id: "n-1", type: "noop", config: {} }],
        edges: [],
      },
    })]);
    mockTerminalRunStatus("succeeded");
    const limit = vi.fn().mockResolvedValue([{ runId: "run-1", nodeId: "n-1" }]);
    selectFromMock.mockReturnValueOnce({ where: vi.fn(() => ({ limit })) } as never);
    isAutoApplyAllowedMock.mockResolvedValueOnce({ allowed: true });

    await handleAutoHealingWatchTrigger();

    expect(decisionMock).toHaveBeenCalledWith("row-1", { actor: "auto", accepted: true });
    expect(replayDeadLetterMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      deadLetterId: "dlq-1",
      recoveryActorId: "system:auto-healing",
    }));
    expect(markDeadLetterReplayedMock).toHaveBeenCalledWith("org-1", "dlq-1");
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
});
