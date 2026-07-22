import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  registerScanner: vi.fn(async () => undefined),
  registerWatcher: vi.fn(async () => undefined),
  worker: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class {},
  Worker: class {
    close = mocks.close;
    on = vi.fn().mockReturnThis();

    constructor(...args: unknown[]) {
      mocks.worker(...args);
    }
  },
}));
vi.mock("@janusly/engine/src/queue", () => ({ connection: { host: "test" } }));
vi.mock("./auto-healing-scanner", () => ({
  AUTO_HEALING_SCAN_JOB_NAME: "scan-auto-healing-candidates",
  handleAutoHealingScanTrigger: vi.fn(),
  registerAutoHealingScannerScheduler: mocks.registerScanner,
}));
vi.mock("./auto-healing-watcher", () => ({
  AUTO_HEALING_WATCH_JOB_NAME: "watch-auto-healing-proposals",
  handleAutoHealingWatchTrigger: vi.fn(),
  registerAutoHealingWatcherScheduler: mocks.registerWatcher,
}));

import { bootstrapAutoHealing, shutdownAutoHealing } from "./auto-healing-bootstrap";

afterEach(async () => {
  await shutdownAutoHealing();
  vi.clearAllMocks();
});

describe("bootstrapAutoHealing", () => {
  it("does not touch Redis or open a Worker when disabled", async () => {
    await bootstrapAutoHealing({ JANUSLY_AUTO_HEALING_ENABLED: "false" });

    expect(mocks.registerScanner).not.toHaveBeenCalled();
    expect(mocks.registerWatcher).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("registers both schedulers and one concurrency-one Worker when enabled", async () => {
    await bootstrapAutoHealing({ JANUSLY_AUTO_HEALING_ENABLED: "true" });
    await bootstrapAutoHealing({ JANUSLY_AUTO_HEALING_ENABLED: "true" });

    expect(mocks.registerScanner).toHaveBeenCalledTimes(2);
    expect(mocks.registerWatcher).toHaveBeenCalledTimes(2);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls[0]?.[0]).toBe("auto-healing-system");
    expect(mocks.worker.mock.calls[0]?.[2]).toMatchObject({ concurrency: 1 });

    await shutdownAutoHealing();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
