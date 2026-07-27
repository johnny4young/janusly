import { beforeEach, describe, expect, it, vi } from "vitest";

const replayDeadLetterMock = vi.hoisted(() => vi.fn());

vi.mock("@janusly/data", () => ({
  claimApplyPublication: vi.fn(),
  claimApplyPublicationRetry: vi.fn(),
  completeApplyPublication: vi.fn(),
  getByIdForOrg: vi.fn(),
  listDueApplyPublications: vi.fn(),
  recordApplyPublicationFailure: vi.fn(),
  recordApplyTerminalFailure: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/dlq-replay", () => ({
  DLQReplayAdapter: class {
    replayDeadLetter = replayDeadLetterMock;
  },
}));

vi.mock("./dlq", () => ({
  getDeadLetter: vi.fn(),
  markDeadLetterReplayed: vi.fn(),
}));

import {
  claimApplyPublication,
  claimApplyPublicationRetry,
  completeApplyPublication,
  getByIdForOrg,
  listDueApplyPublications,
  recordApplyPublicationFailure,
  recordApplyTerminalFailure,
} from "@janusly/data";
import { getDeadLetter, markDeadLetterReplayed } from "./dlq";
import {
  applyValidatedAutoHealing,
  repairAutoHealingPublications,
} from "./auto-healing-apply";

const claimMock = vi.mocked(claimApplyPublication);
const retryClaimMock = vi.mocked(claimApplyPublicationRetry);
const completeMock = vi.mocked(completeApplyPublication);
const getRowMock = vi.mocked(getByIdForOrg);
const listDueMock = vi.mocked(listDueApplyPublications);
const publicationFailureMock = vi.mocked(recordApplyPublicationFailure);
const terminalFailureMock = vi.mocked(recordApplyTerminalFailure);
const getDeadLetterMock = vi.mocked(getDeadLetter);
const markReplayedMock = vi.mocked(markDeadLetterReplayed);

const workflow = {
  id: "wf-1",
  name: "Workflow",
  nodes: [{ id: "n-1", type: "noop", config: {} }],
  edges: [],
};

function row(status: "validated" | "publishing" | "publish_failed" = "validated") {
  return {
    id: "heal-1",
    orgId: "org-1",
    deadLetterId: "dlq-1",
    signature: "failure-signature",
    status,
    proposedPatchJson: workflow,
    approachLabel: "other",
    confidence: 80,
    validationRunId: "validation-1",
    validationSignature: null,
    decisionActor: status === "validated" ? null : "user-1",
    publicationReceipt: status === "validated" ? null : "receipt-1",
    publicationRepairAfter: status === "validated" ? null : new Date(0),
    publicationAttempts: status === "validated" ? 0 : 1,
    declineReason: null,
    loopAttemptCount: 1,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as const;
}

function deadLetter(
  replayClaimToken: string | null = null,
  replayClaimedAt: Date | null = null,
  status: "open" | "replayed" | "resolved" = "open",
) {
  return {
    id: "dlq-1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "n-1",
    status,
    workflowJson: workflow,
    replayClaimToken,
    replayClaimedAt,
  } as never;
}

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue({ claimed: true, receipt: "receipt-1" });
  retryClaimMock.mockReset().mockResolvedValue("receipt-1");
  completeMock.mockReset().mockResolvedValue(true);
  getRowMock.mockReset().mockResolvedValue(row() as never);
  listDueMock.mockReset().mockResolvedValue([]);
  publicationFailureMock.mockReset().mockResolvedValue(undefined);
  terminalFailureMock.mockReset().mockResolvedValue(undefined);
  getDeadLetterMock.mockReset();
  markReplayedMock.mockReset().mockResolvedValue(true);
  replayDeadLetterMock.mockReset().mockResolvedValue(undefined);
});

describe("applyValidatedAutoHealing", () => {
  it("marks applied only after the exact replay receipt is durable", async () => {
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()));

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result.outcome).toBe("applied");
    expect(replayDeadLetterMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      deadLetterId: "dlq-1",
      recoveryClaimToken: "receipt-1",
      recoveryActorId: "user-1",
    }));
    expect(markReplayedMock).toHaveBeenCalledWith(
      "org-1",
      "dlq-1",
      "receipt-1",
    );
    expect(completeMock).toHaveBeenCalledWith("org-1", "heal-1", "receipt-1");
    expect(publicationFailureMock).not.toHaveBeenCalled();
  });

  it("recovers when the adapter throws after persisting the durable claim", async () => {
    replayDeadLetterMock.mockRejectedValueOnce(new Error("redis unavailable"));
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()));

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result.outcome).toBe("applied");
    expect(completeMock).toHaveBeenCalled();
    expect(publicationFailureMock).not.toHaveBeenCalled();
  });

  it("keeps a retryable state when no durable claim exists", async () => {
    replayDeadLetterMock.mockRejectedValueOnce(new Error("claim failed"));
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter());

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result.outcome).toBe("pending");
    expect(publicationFailureMock).toHaveBeenCalledWith(
      "org-1",
      "heal-1",
      "receipt-1",
      "claim failed",
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("rejects an already claimed dead letter before claiming the proposal", async () => {
    getDeadLetterMock.mockResolvedValueOnce(
      deadLetter("another-receipt", new Date()),
    );

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result).toMatchObject({
      outcome: "rejected",
      code: "publication_conflict",
    });
    expect(claimMock).not.toHaveBeenCalled();
    expect(replayDeadLetterMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual resolution after the durable claim", async () => {
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()));
    markReplayedMock.mockResolvedValueOnce(false);

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result).toMatchObject({
      outcome: "rejected",
      code: "publication_conflict",
    });
    expect(terminalFailureMock).toHaveBeenCalledWith(
      "org-1",
      "heal-1",
      "receipt-1",
      "signature_already_resolved",
      expect.any(String),
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("keeps the publication repairable when applied state and audit cannot commit", async () => {
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter())
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()));
    completeMock.mockRejectedValueOnce(new Error("postgres unavailable"));

    const result = await applyValidatedAutoHealing({
      orgId: "org-1",
      id: "heal-1",
      actor: "user-1",
    });

    expect(result.outcome).toBe("pending");
    expect(publicationFailureMock).toHaveBeenCalledWith(
      "org-1",
      "heal-1",
      "receipt-1",
      "postgres unavailable",
    );
  });
});

describe("repairAutoHealingPublications", () => {
  it("completes an expired row from its existing durable receipt without replaying", async () => {
    listDueMock.mockResolvedValueOnce([row("publish_failed") as never]);
    getRowMock.mockResolvedValueOnce(row("publishing") as never);
    getDeadLetterMock
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()))
      .mockResolvedValueOnce(deadLetter("receipt-1", new Date()));

    const result = await repairAutoHealingPublications();

    expect(result).toEqual({ scanned: 1, applied: 1, pending: 0, failed: 0 });
    expect(replayDeadLetterMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledWith("org-1", "heal-1", "receipt-1");
  });

  it("terminates a publication whose dead letter was claimed by another action", async () => {
    listDueMock.mockResolvedValueOnce([row("publish_failed") as never]);
    getRowMock.mockResolvedValueOnce(row("publishing") as never);
    getDeadLetterMock.mockResolvedValueOnce(
      deadLetter("another-receipt", new Date()),
    );

    const result = await repairAutoHealingPublications();

    expect(result.failed).toBe(1);
    expect(terminalFailureMock).toHaveBeenCalledWith(
      "org-1",
      "heal-1",
      "receipt-1",
      "signature_already_resolved",
      expect.any(String),
    );
  });
});
