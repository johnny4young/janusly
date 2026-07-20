import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileSubworkflowTerminals,
  registerSubworkflowTerminalReconciler,
  SUBWORKFLOW_TERMINAL_RECONCILER_CRON,
  SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID,
  SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME,
  SUBWORKFLOW_TERMINAL_RECONCILER_LIMIT,
} from "./subworkflow-terminal-reconciler";

const { upsertJobScheduler } = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
}));
vi.mock("./queue", () => ({
  workflowQueue: { upsertJobScheduler },
}));

describe("subworkflow terminal reconciler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delivers every claimed child and isolates unsettled or thrown handoffs", async () => {
    const notifications = [
      { runId: "child-ok", status: "succeeded" as const, leaseUntil: new Date("2026-07-15T15:00:00Z") },
      { runId: "child-unsettled", status: "failed" as const, leaseUntil: new Date("2026-07-15T15:00:01Z") },
      { runId: "child-throws", status: "cancelled" as const, leaseUntil: new Date("2026-07-15T15:00:02Z") },
    ];
    const claimDue = vi.fn().mockResolvedValue(notifications);
    const deliver = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("db unavailable"));

    await expect(reconcileSubworkflowTerminals({ claimDue, deliver }))
      .resolves.toEqual({ scanned: 3, repaired: 1, failed: 2 });
    expect(claimDue).toHaveBeenCalledWith(expect.any(Date), SUBWORKFLOW_TERMINAL_RECONCILER_LIMIT);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver).toHaveBeenNthCalledWith(1, notifications[0]);
    expect(deliver).toHaveBeenNthCalledWith(3, notifications[2]);
  });

  it("registers one stable global scheduler", async () => {
    upsertJobScheduler.mockResolvedValue(undefined);

    await expect(registerSubworkflowTerminalReconciler()).resolves.toBe(true);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID,
      { pattern: SUBWORKFLOW_TERMINAL_RECONCILER_CRON },
      { name: SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME, data: {} },
    );
  });
});
