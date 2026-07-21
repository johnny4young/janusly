import { describe, expect, it, vi } from "vitest";

import {
  createMaintenanceQueueCountReader,
  createWorkflowQueueCountReader,
} from "./queue-reader";

describe("createWorkflowQueueCountReader", () => {
  it("coalesces concurrent scrapes and closes its client", async () => {
    let resolveCounts: ((value: { waiting: number; active: number }) => void) | undefined;
    const getJobCounts = vi.fn(() => new Promise<{ waiting: number; active: number }>((resolve) => {
      resolveCounts = resolve;
    }));
    const close = vi.fn().mockResolvedValue(undefined);
    const reader = createWorkflowQueueCountReader(() => ({ getJobCounts, close } as never));

    const first = reader.getCounts();
    const second = reader.getCounts();
    await Promise.resolve();
    expect(getJobCounts).toHaveBeenCalledTimes(1);
    resolveCounts?.({ waiting: 4, active: 2 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { waiting: 4, active: 2 },
      { waiting: 4, active: 2 },
    ]);

    await reader.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("recreates a poisoned client after Redis recovers", async () => {
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const firstClient = {
      getJobCounts: vi.fn().mockRejectedValue(new Error("redis offline")),
      close: firstClose,
    };
    const secondClient = {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, active: 0 }),
      close: secondClose,
    };
    const createClient = vi.fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);
    const reader = createWorkflowQueueCountReader(createClient);

    await expect(reader.getCounts()).rejects.toThrow("redis offline");
    await expect(reader.getCounts()).resolves.toEqual({ waiting: 1, active: 0 });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(firstClient.getJobCounts).toHaveBeenCalledTimes(1);
    expect(secondClient.getJobCounts).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);

    await reader.close();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("gives the maintenance reader the same bounded/coalesced lifecycle", async () => {
    const getJobCounts = vi.fn().mockResolvedValue({ waiting: 3, active: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    const reader = createMaintenanceQueueCountReader(() => ({ getJobCounts, close } as never));

    await expect(reader.getCounts()).resolves.toEqual({ waiting: 3, active: 1 });
    await reader.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
