import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_PUBLICATION_RECONCILER_LIMIT,
  reconcileQueuePublications,
} from "./queue-publication-reconciler";
import type { DueQueuePublicationRepair } from "./persistence";

vi.mock("./queue", () => ({
  workflowQueue: { upsertJobScheduler: vi.fn() },
}));

const workflow = {
  dslVersion: "1.0" as const,
  nodes: [{ id: "n1", type: "noop" as const, config: {} }],
  edges: [],
};

function repair(overrides: Partial<DueQueuePublicationRepair> = {}): DueQueuePublicationRepair {
  return {
    runId: "run-1",
    nodeId: "n1",
    status: "queued",
    attempt: 1,
    recoveryClaimToken: null,
    publicationGeneration: 1,
    ...overrides,
  };
}

describe("reconcileQueuePublications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-publishes exact queued generations and scans pending runs once", async () => {
    const queued = repair({
      nodeId: "queued",
      attempt: 3,
      recoveryClaimToken: "claim-3",
      publicationGeneration: 4,
    });
    const pendingA = repair({ status: "pending", nodeId: "pending-a" });
    const pendingB = repair({ status: "pending", nodeId: "pending-b" });
    const enqueueQueued = vi.fn().mockResolvedValue(undefined);
    const loadWorkflow = vi.fn().mockResolvedValue(workflow);
    const enqueueReady = vi.fn().mockResolvedValue(2);
    const claimDue = vi.fn().mockResolvedValue([queued, pendingA, pendingB]);

    await expect(reconcileQueuePublications({ claimDue, enqueueQueued, loadWorkflow, enqueueReady }))
      .resolves.toEqual({ scanned: 3, repaired: 2, failed: 0 });
    expect(claimDue).toHaveBeenCalledWith(expect.any(Date), QUEUE_PUBLICATION_RECONCILER_LIMIT);
    expect(enqueueQueued).toHaveBeenCalledWith(queued);
    expect(loadWorkflow).toHaveBeenCalledTimes(1);
    expect(loadWorkflow).toHaveBeenCalledWith("run-1");
    expect(enqueueReady).toHaveBeenCalledTimes(1);
    expect(enqueueReady).toHaveBeenCalledWith("run-1", expect.objectContaining(workflow));
  });

  it("isolates invalid snapshots and queue failures", async () => {
    const enqueueQueued = vi.fn().mockRejectedValue(new Error("redis down"));
    const enqueueReady = vi.fn();
    const loadWorkflow = vi.fn().mockResolvedValue({ nope: true });
    const claimDue = vi.fn().mockResolvedValue([
      repair(),
      repair({ runId: "run-invalid", status: "pending" }),
    ]);

    await expect(reconcileQueuePublications({ claimDue, enqueueQueued, loadWorkflow, enqueueReady }))
      .resolves.toEqual({ scanned: 2, repaired: 0, failed: 2 });
    expect(enqueueReady).not.toHaveBeenCalled();
  });
});
