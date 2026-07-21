import { describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_WORKER_CONCURRENCY_DEFAULT,
  migrateMaintenanceSchedulers,
  resolveMaintenanceWorkerConcurrency,
  type MaintenanceSchedulerSpec,
} from "./maintenance-control";

describe("resolveMaintenanceWorkerConcurrency", () => {
  it.each([undefined, "", "0", "5", "1.5", "nope"])(
    "uses the low default for %s",
    (raw) => expect(resolveMaintenanceWorkerConcurrency(raw)).toBe(
      MAINTENANCE_WORKER_CONCURRENCY_DEFAULT,
    ),
  );

  it.each([1, 2, 3, 4])("accepts bounded concurrency %s", (value) => {
    expect(resolveMaintenanceWorkerConcurrency(String(value))).toBe(value);
  });
});

describe("migrateMaintenanceSchedulers", () => {
  it("retires a legacy scheduler only after its replacement succeeds", async () => {
    const events: string[] = [];
    const specs: MaintenanceSchedulerSpec[] = [
      {
        id: "system:ready",
        label: "ready",
        register: vi.fn(async () => {
          events.push("register:ready");
          return true;
        }),
      },
      {
        id: "system:failed",
        label: "failed",
        register: vi.fn(async () => {
          events.push("register:failed");
          return false;
        }),
      },
    ];
    const legacyQueue = {
      removeJobScheduler: vi.fn(async (id: string) => {
        events.push(`retire:${id}`);
        return true;
      }),
    };

    await expect(migrateMaintenanceSchedulers(specs, legacyQueue as never)).resolves.toEqual({
      registered: 1,
      retiredLegacy: 1,
    });
    expect(events).toEqual([
      "register:ready",
      "retire:system:ready",
      "register:failed",
    ]);
  });

  it("continues after registration and retirement failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const specs: MaintenanceSchedulerSpec[] = [
      {
        id: "system:throws",
        label: "throws",
        register: vi.fn().mockRejectedValue(new Error("register offline")),
      },
      {
        id: "system:ready",
        label: "ready",
        register: vi.fn().mockResolvedValue(true),
      },
    ];
    const legacyQueue = {
      removeJobScheduler: vi.fn().mockRejectedValue(new Error("legacy offline")),
    };

    await expect(migrateMaintenanceSchedulers(specs, legacyQueue as never)).resolves.toEqual({
      registered: 1,
      retiredLegacy: 0,
    });
    expect(legacyQueue.removeJobScheduler).toHaveBeenCalledWith("system:ready");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("does not report a legacy retirement when no old scheduler existed", async () => {
    const spec: MaintenanceSchedulerSpec = {
      id: "system:new-only",
      label: "new-only",
      register: vi.fn().mockResolvedValue(true),
    };
    const legacyQueue = { removeJobScheduler: vi.fn().mockResolvedValue(false) };

    await expect(migrateMaintenanceSchedulers([spec], legacyQueue as never)).resolves.toEqual({
      registered: 1,
      retiredLegacy: 0,
    });
  });
});
