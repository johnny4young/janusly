import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persistence", () => ({
  escalateWaitingApprovalNode: vi.fn(),
  failWaitingApprovalNode: vi.fn(),
  getRunNodeWaitingSnapshot: vi.fn(),
}));

vi.mock("./queue", () => ({
  enqueueApprovalDeadlineArm: vi.fn(),
  enqueueApprovalTimeout: vi.fn(),
}));

import {
  escalateWaitingApprovalNode,
  failWaitingApprovalNode,
  getRunNodeWaitingSnapshot,
} from "./persistence";
import { enqueueApprovalDeadlineArm, enqueueApprovalTimeout } from "./queue";
import { approvalExecutor, handleApprovalDeadlineArm, handleApprovalTimeout } from "./approval-timeout";

const getSnapshotMock = vi.mocked(getRunNodeWaitingSnapshot);
const enqueueMock = vi.mocked(enqueueApprovalTimeout);
const enqueueArmMock = vi.mocked(enqueueApprovalDeadlineArm);
const failMock = vi.mocked(failWaitingApprovalNode);
const escalateMock = vi.mocked(escalateWaitingApprovalNode);

beforeEach(() => {
  vi.restoreAllMocks();
  getSnapshotMock.mockReset();
  enqueueMock.mockReset();
  enqueueArmMock.mockReset();
  failMock.mockReset().mockResolvedValue(true);
  escalateMock.mockReset().mockResolvedValue(true);
});

describe("approvalExecutor", () => {
  it("keeps legacy approvals indefinite while exposing ownership metadata", async () => {
    const result = await approvalExecutor(context({ message: "Approve refund", assignee: "owner-1" }));

    expect(result).toMatchObject({
      status: "waiting",
      metadata: { kind: "approval", title: "Approve refund", assignee: "owner-1" },
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(enqueueArmMock).not.toHaveBeenCalled();
  });

  it("installs a watcher and defers the relative clock until the waiting checkpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-14T12:00:00Z"));
    const result = await approvalExecutor(context({ decisionTimeoutMs: 60_000 }));

    expect(enqueueArmMock).toHaveBeenCalledWith("run-1", "gate", 0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "waiting",
      metadata: {
        decisionTimeoutMs: 60_000,
        onTimeout: "fail",
      },
    });
    if (result.status !== "waiting") throw new Error("Expected approval to wait");
    expect(result.metadata).not.toHaveProperty("deadlineAt");
  });
});

describe("handleApprovalDeadlineArm", () => {
  it("bridges pre-checkpoint execution then schedules the persisted generation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-14T12:00:00Z"));
    const deadlineAt = "2026-07-14T12:01:00.000Z";
    getSnapshotMock
      .mockResolvedValueOnce({ status: "running", waiting: null })
      .mockResolvedValueOnce(waiting({ deadlineAt, onTimeout: "fail" }));

    await handleApprovalDeadlineArm({ runId: "run-1", nodeId: "gate" });
    expect(enqueueArmMock).toHaveBeenCalledWith("run-1", "gate", 1_000);

    await handleApprovalDeadlineArm({ runId: "run-1", nodeId: "gate" });
    expect(enqueueMock).toHaveBeenCalledWith("run-1", "gate", deadlineAt, 60_000);
  });
});

describe("handleApprovalTimeout", () => {
  const deadlineAt = "2026-07-14T12:00:00.000Z";

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-14T12:01:00Z"));
  });

  it("fails a still-current approval through the atomic node/run transition", async () => {
    getSnapshotMock.mockResolvedValueOnce(waiting({ deadlineAt, onTimeout: "fail" }));

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });

    expect(failMock).toHaveBeenCalledWith("run-1", "gate", deadlineAt, "fail");
  });

  it("keeps auto rejection terminal instead of resuming downstream", async () => {
    getSnapshotMock.mockResolvedValueOnce(waiting({ deadlineAt, onTimeout: "auto_reject" }));

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });

    expect(failMock).toHaveBeenCalledWith("run-1", "gate", deadlineAt, "auto_reject");
  });

  it("reassigns escalation without making downstream ready", async () => {
    getSnapshotMock.mockResolvedValueOnce(waiting({ deadlineAt, onTimeout: "escalate", escalateTo: "tier-2" }));

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });

    expect(escalateMock).toHaveBeenCalledWith("run-1", "gate", deadlineAt, "tier-2");
    expect(failMock).not.toHaveBeenCalled();
  });

  it("retries when the job arrives before waiting state is persisted", async () => {
    getSnapshotMock.mockResolvedValueOnce({ status: "running", waiting: null });

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });

    expect(enqueueMock).toHaveBeenCalledWith("run-1", "gate", deadlineAt, 1_000);
    expect(failMock).not.toHaveBeenCalled();
  });

  it("propagates infrastructure failures so BullMQ can retry the durable job", async () => {
    getSnapshotMock.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt }))
      .rejects.toThrow("database unavailable");

    getSnapshotMock.mockResolvedValueOnce({ status: "running", waiting: null });
    enqueueMock.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt, statusCheckAttempts: 10_000 }))
      .rejects.toThrow("redis unavailable");
  });

  it("no-ops for manual resume, stale generations, and duplicate escalation delivery", async () => {
    getSnapshotMock
      .mockResolvedValueOnce({ status: "succeeded", waiting: null })
      .mockResolvedValueOnce(waiting({ deadlineAt: "2026-07-14T13:00:00.000Z", onTimeout: "fail" }))
      .mockResolvedValueOnce(waiting({ deadlineAt, onTimeout: "escalate", escalateTo: "tier-2", timeoutState: "escalated" }));

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });
    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });
    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt });

    expect(failMock).not.toHaveBeenCalled();
    expect(escalateMock).not.toHaveBeenCalled();
  });

  it("reschedules against the persisted clock when BullMQ delivers early", async () => {
    const future = "2026-07-14T12:02:00.000Z";
    getSnapshotMock.mockResolvedValueOnce(waiting({ deadlineAt: future, onTimeout: "fail" }));

    await handleApprovalTimeout({ runId: "run-1", nodeId: "gate", deadlineAt: future });

    expect(enqueueMock).toHaveBeenCalledWith("run-1", "gate", future, 60_000);
    expect(failMock).not.toHaveBeenCalled();
  });
});

function context(config: Record<string, unknown>) {
  return {
    runId: "run-1",
    nodeId: "gate",
    orgId: "org-1",
    workflowId: null,
    config,
    context: {},
    redactedValues: [],
  };
}

function waiting(metadata: Record<string, unknown>) {
  return { status: "waiting", waiting: { kind: "approval", ...metadata } };
}
