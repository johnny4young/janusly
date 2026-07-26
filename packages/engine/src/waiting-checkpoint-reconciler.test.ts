import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persistence", () => ({
  claimDueWaitingCheckpoints: vi.fn(),
}));
vi.mock("./queue", () => ({
  enqueueApprovalTimeout: vi.fn(),
  enqueueWaitUntilResume: vi.fn(),
  maintenanceQueue: { upsertJobScheduler: vi.fn() },
}));

import { maintenanceQueue } from "./queue";
import {
  reconcileWaitingCheckpoints,
  registerWaitingCheckpointReconciler,
  WAITING_CHECKPOINT_RECONCILER_CRON,
  WAITING_CHECKPOINT_RECONCILER_JOB_ID,
  WAITING_CHECKPOINT_RECONCILER_JOB_NAME,
} from "./waiting-checkpoint-reconciler";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(maintenanceQueue.upsertJobScheduler).mockReset().mockResolvedValue(undefined as never);
});

describe("waiting checkpoint reconciler", () => {
  it("recreates approval and timer jobs while isolating a row failure", async () => {
    const enqueueApproval = vi.fn().mockRejectedValueOnce(new Error("redis unavailable"));
    const enqueueTimer = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await reconcileWaitingCheckpoints({
      claimDue: vi.fn().mockResolvedValue([
        { runId: "run-1", nodeId: "gate", kind: "approval", targetAt: "2026-07-14T12:00:00.000Z" },
        { runId: "run-2", nodeId: "wait", kind: "timer", targetAt: "2026-07-14T12:00:00.000Z" },
      ]),
      enqueueApproval,
      enqueueTimer,
    }, new Date("2026-07-14T12:01:00.000Z"));

    expect(result).toEqual({ scanned: 2, requeued: 1, failed: 1 });
    expect(enqueueApproval).toHaveBeenCalledWith("run-1", "gate", "2026-07-14T12:00:00.000Z", 0);
    expect(enqueueTimer).toHaveBeenCalledWith("run-2", "wait", 0);
  });

  it("registers one deterministic once-per-minute scheduler and fails open", async () => {
    await expect(registerWaitingCheckpointReconciler()).resolves.toBe(true);
    expect(maintenanceQueue.upsertJobScheduler).toHaveBeenCalledWith(
      WAITING_CHECKPOINT_RECONCILER_JOB_ID,
      { pattern: WAITING_CHECKPOINT_RECONCILER_CRON },
      { name: WAITING_CHECKPOINT_RECONCILER_JOB_NAME, data: {} },
    );

    vi.mocked(maintenanceQueue.upsertJobScheduler).mockRejectedValueOnce(new Error("redis unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(registerWaitingCheckpointReconciler()).resolves.toBe(false);
  });
});
