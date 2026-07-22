import { beforeEach, describe, expect, it, vi } from "vitest";

const meterMock = vi.hoisted(() => {
  const callbacks: Array<{
    callback: (result: { observe: (instrument: unknown, value: number) => void }) => Promise<void>;
    instruments: unknown[];
  }> = [];
  const histograms: Array<{ name: string; record: ReturnType<typeof vi.fn> }> = [];
  const counters: Array<{ name: string; add: ReturnType<typeof vi.fn> }> = [];
  return {
    callbacks,
    counters,
    getMeter: vi.fn(),
    histograms,
    meter: {
      createHistogram: vi.fn((name: string) => {
        const instrument = { name, record: vi.fn() };
        histograms.push(instrument);
        return instrument;
      }),
      createCounter: vi.fn((name: string) => {
        const instrument = { name, add: vi.fn() };
        counters.push(instrument);
        return instrument;
      }),
      createObservableGauge: vi.fn((name: string) => ({ name })),
      addBatchObservableCallback: vi.fn((callback, instruments) => {
        callbacks.push({ callback, instruments });
      }),
      removeBatchObservableCallback: vi.fn(),
    },
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: meterMock.getMeter.mockReturnValue(meterMock.meter) },
}));

import {
  incNodeFailure,
  incNodeRetry,
  recordNodeDuration,
  registerQueueObservables,
  registerRateLimiterObservables,
} from "./metrics";

describe("observable metrics", () => {
  beforeEach(() => {
    meterMock.callbacks.length = 0;
    meterMock.meter.addBatchObservableCallback.mockClear();
    meterMock.meter.removeBatchObservableCallback.mockClear();
    meterMock.meter.createHistogram.mockClear();
    meterMock.meter.createCounter.mockClear();
  });

  it("observes waiting and active queue counts and unregisters cleanly", async () => {
    expect(meterMock.getMeter).not.toHaveBeenCalled();
    const unregister = registerQueueObservables(async () => ({ waiting: 7, active: 3 }));
    const observe = vi.fn();
    await meterMock.callbacks[0]?.callback({ observe });
    expect(meterMock.getMeter).toHaveBeenCalledWith("janusly");
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      name: "workflow_queue_waiting_jobs",
    }), 7);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      name: "workflow_queue_active_jobs",
    }), 3);

    unregister();
    expect(meterMock.meter.removeBatchObservableCallback).toHaveBeenCalledWith(
      meterMock.callbacks[0]?.callback,
      meterMock.callbacks[0]?.instruments,
    );
  });

  it("observes the process-local degraded bucket count", async () => {
    registerRateLimiterObservables(() => 2);
    const observe = vi.fn();
    await meterMock.callbacks[0]?.callback({ observe });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      name: "janusly_rate_limit_degraded_buckets",
    }), 2);
  });

  it("publishes maintenance queue counts on independent instruments", async () => {
    registerQueueObservables(() => ({ waiting: 5, active: 2 }), "maintenance");
    const observe = vi.fn();
    await meterMock.callbacks[0]?.callback({ observe });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      name: "maintenance_queue_waiting_jobs",
    }), 5);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      name: "maintenance_queue_active_jobs",
    }), 2);
  });

  it("omits malformed values and swallowed loader failures", async () => {
    registerQueueObservables(() => ({ waiting: -1, active: 1 }));
    registerRateLimiterObservables(async () => { throw new Error("snapshot failed"); });
    const observe = vi.fn();
    await meterMock.callbacks[0]?.callback({ observe });
    await meterMock.callbacks[1]?.callback({ observe });
    expect(observe).not.toHaveBeenCalled();
  });

  it("records node duration, terminal failures, and retries", () => {
    recordNodeDuration(42, { node_type: "noop" });
    incNodeFailure({ node_type: "http" });
    incNodeRetry({ node_type: "http" });

    expect(meterMock.histograms.find(({ name }) => name === "workflow_node_duration_ms")?.record)
      .toHaveBeenCalledWith(42, { node_type: "noop" });
    expect(meterMock.counters.find(({ name }) => name === "workflow_node_failures_total")?.add)
      .toHaveBeenCalledWith(1, { node_type: "http" });
    expect(meterMock.counters.find(({ name }) => name === "workflow_node_retries_total")?.add)
      .toHaveBeenCalledWith(1, { node_type: "http" });
  });
});
