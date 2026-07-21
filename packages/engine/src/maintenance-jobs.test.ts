import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  removeJobScheduler: vi.fn(),
}));

vi.mock("./queue", () => ({
  maintenanceQueue: { upsertJobScheduler: queueMocks.upsertJobScheduler },
  workflowQueue: { removeJobScheduler: queueMocks.removeJobScheduler },
}));

import {
  dispatchMaintenanceJob,
  MAINTENANCE_SCHEDULERS,
  registerAndMigrateMaintenanceSchedulers,
} from "./maintenance-jobs";

describe("maintenance job catalog", () => {
  beforeEach(() => {
    queueMocks.upsertJobScheduler.mockReset().mockResolvedValue(undefined);
    queueMocks.removeJobScheduler.mockReset().mockResolvedValue(true);
  });

  it("keeps every recurring id unique and reserved for system work", () => {
    const ids = MAINTENANCE_SCHEDULERS.map((scheduler) => scheduler.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("system:"))).toBe(true);
  });

  it("registers every recurrence before retiring its workflow-queue predecessor", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(registerAndMigrateMaintenanceSchedulers()).resolves.toEqual({
        registered: 12,
        retiredLegacy: 12,
      });
      expect(queueMocks.upsertJobScheduler).toHaveBeenCalledTimes(12);
      expect(queueMocks.removeJobScheduler).toHaveBeenCalledTimes(12);
      for (let index = 0; index < 12; index += 1) {
        expect(queueMocks.upsertJobScheduler.mock.invocationCallOrder[index])
          .toBeLessThan(queueMocks.removeJobScheduler.mock.invocationCallOrder[index] ?? 0);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("rejects unknown maintenance names without misreading them as node jobs", async () => {
    await expect(dispatchMaintenanceJob("execute-node", {})).resolves.toBe(false);
    await expect(dispatchMaintenanceJob("unknown-system-job", {})).resolves.toBe(false);
  });
});
