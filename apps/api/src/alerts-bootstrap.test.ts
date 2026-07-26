import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  dispatchAlert: vi.fn(),
  registerScheduler: vi.fn(async () => undefined),
  setDispatcher: vi.fn(),
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
vi.mock("@janusly/data", () => ({ setAlertDispatcher: mocks.setDispatcher }));
vi.mock("@janusly/engine/src/alerts/dispatcher", () => ({
  dispatchAlert: mocks.dispatchAlert,
}));
vi.mock("./alerts/scanner", () => ({
  ALERTS_SCAN_JOB_NAME: "scan-alert-policies",
  handleAlertsScanTrigger: vi.fn(),
  registerAlertsScannerScheduler: mocks.registerScheduler,
}));

import { bootstrapAlerts, shutdownAlerts } from "./alerts-bootstrap";

afterEach(async () => {
  await shutdownAlerts();
  vi.clearAllMocks();
});

describe("bootstrapAlerts", () => {
  it("keeps event-driven dispatch active while the periodic scanner is disabled", async () => {
    await bootstrapAlerts({ JANUSLY_ALERTS_ENABLED: "false" });

    expect(mocks.setDispatcher).toHaveBeenCalledWith(mocks.dispatchAlert);
    expect(mocks.registerScheduler).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("registers one concurrency-one scanner Worker when enabled", async () => {
    await bootstrapAlerts({ JANUSLY_ALERTS_ENABLED: "true" });
    await bootstrapAlerts({ JANUSLY_ALERTS_ENABLED: "true" });

    expect(mocks.registerScheduler).toHaveBeenCalledTimes(2);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls[0]?.[0]).toBe("alerts-system");
    expect(mocks.worker.mock.calls[0]?.[2]).toMatchObject({ concurrency: 1 });

    await shutdownAlerts();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.setDispatcher).toHaveBeenLastCalledWith(null);
  });
});
