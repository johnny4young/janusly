import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconcileWorkflowRolloutOutcomes,
  registerWorkflowRolloutReconciler,
  WORKFLOW_ROLLOUT_RECONCILER_CRON,
  WORKFLOW_ROLLOUT_RECONCILER_JOB_ID,
  WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME,
  WORKFLOW_ROLLOUT_RECONCILER_LIMIT,
} from "./workflow-rollout-reconciler";

const { upsertJobScheduler } = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
}));

vi.mock("./queue", () => ({
  workflowQueue: { upsertJobScheduler },
}));

vi.mock("@janusly/data", () => ({
  listUnrecordedWorkflowRolloutOutcomes: vi.fn(),
  recordWorkflowRolloutOutcome: vi.fn(),
}));

describe("workflow rollout reconciler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a bounded batch and isolates duplicate, ignored, and failed runs", async () => {
    const candidates = [
      { runId: "recorded", status: "succeeded" as const },
      { runId: "duplicate", status: "failed" as const },
      { runId: "ignored", status: "cancelled" as const },
      { runId: "failed", status: "failed" as const },
    ];
    const listDue = vi.fn().mockResolvedValue(candidates);
    const record = vi.fn()
      .mockResolvedValueOnce({ kind: "recorded", autoRolledBack: false, rollout: {} })
      .mockResolvedValueOnce({ kind: "duplicate" })
      .mockResolvedValueOnce({ kind: "ignored" })
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(reconcileWorkflowRolloutOutcomes({ listDue, record })).resolves.toEqual({
      scanned: 4,
      recorded: 1,
      duplicate: 1,
      ignored: 1,
      failed: 1,
    });
    expect(listDue).toHaveBeenCalledWith(WORKFLOW_ROLLOUT_RECONCILER_LIMIT);
    expect(record).toHaveBeenCalledTimes(4);
    expect(record).toHaveBeenNthCalledWith(1, "recorded", "succeeded");
    expect(record).toHaveBeenNthCalledWith(3, "ignored", "cancelled");
  });

  it("registers one stable global scheduler", async () => {
    upsertJobScheduler.mockResolvedValue(undefined);

    await expect(registerWorkflowRolloutReconciler()).resolves.toBe(true);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      WORKFLOW_ROLLOUT_RECONCILER_JOB_ID,
      { pattern: WORKFLOW_ROLLOUT_RECONCILER_CRON },
      { name: WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME, data: {} },
    );
  });
});
