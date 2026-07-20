/** Unit coverage for bounded workflow-queue health and public truncation. */

import { describe, expect, it, vi } from "vitest";

import {
  createQueueHealthCache,
  createQueueHealthSource,
  getWaitingEligibleTimestamp,
  readQueueHealthSnapshot,
  resolveQueueLagWarnSeconds,
  toPublicQueueHealth,
  type QueueHealthSource,
} from "./queue-health";

function source(overrides: Partial<QueueHealthSource> = {}): QueueHealthSource {
  return {
    getCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 3 }),
    getOldestWaitingTimestamp: vi.fn().mockResolvedValue(40_000),
    ...overrides,
  };
}

describe("readQueueHealthSnapshot", () => {
  it("reports bounded counts and the oldest waiting age", async () => {
    await expect(readQueueHealthSnapshot(source(), {
      now: () => 100_500,
      warnSeconds: 60,
    })).resolves.toEqual({
      waiting: 2,
      active: 3,
      oldestWaitingSeconds: 60,
      warnSeconds: 60,
    });
  });

  it("skips the oldest-job read when no work is waiting", async () => {
    const getOldestWaitingTimestamp = vi.fn().mockResolvedValue(1);
    const snapshot = await readQueueHealthSnapshot(source({
      getCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 1 }),
      getOldestWaitingTimestamp,
    }), { now: () => 100_000, warnSeconds: 30 });
    expect(snapshot.oldestWaitingSeconds).toBeNull();
    expect(getOldestWaitingTimestamp).not.toHaveBeenCalled();
  });

  it.each([
    { waiting: -1, active: 0 },
    { waiting: 1.5, active: 0 },
    { waiting: 0, active: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid adapter counts %#", async (counts) => {
    await expect(readQueueHealthSnapshot(source({
      getCounts: vi.fn().mockResolvedValue(counts),
    }))).rejects.toThrow(/Invalid workflow queue/);
  });
});

describe("getWaitingEligibleTimestamp", () => {
  it("uses delayed-job eligibility rather than creation time", () => {
    expect(getWaitingEligibleTimestamp({
      timestamp: 10_000,
      opts: { delay: 50_000 },
    })).toBe(60_000);
  });

  it("does not infer stalled-work age from its previous attempt start", () => {
    expect(getWaitingEligibleTimestamp({
      timestamp: 10_000,
      processedOn: 90_000,
      opts: { delay: 5_000 },
    })).toBeNull();
  });

  it("does not infer retry age from the attempt start", () => {
    expect(getWaitingEligibleTimestamp({
      timestamp: 10_000,
      processedOn: 90_000,
      opts: { delay: 5_000 },
    })).toBeNull();
  });

  it("rejects malformed timestamps", () => {
    expect(getWaitingEligibleTimestamp({ timestamp: Number.NaN })).toBeNull();
    expect(getWaitingEligibleTimestamp(null)).toBeNull();
  });
});

describe("queue health projection and cache", () => {
  it("publishes only a coarse degraded flag and uses a strict threshold", () => {
    expect(toPublicQueueHealth({
      waiting: 4,
      active: 2,
      oldestWaitingSeconds: 60,
      warnSeconds: 60,
    })).toEqual({ degraded: false });
    expect(toPublicQueueHealth({
      waiting: 4,
      active: 2,
      oldestWaitingSeconds: 61,
      warnSeconds: 60,
    })).toEqual({ degraded: true });
    expect(toPublicQueueHealth(null)).toBeNull();
  });

  it("coalesces concurrent reads and caches success for five seconds", async () => {
    let now = 1_000;
    const load = vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      oldestWaitingSeconds: null,
      warnSeconds: 60,
    });
    const cache = createQueueHealthCache(load, { now: () => now, ttlMs: 5_000 });

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);

    now = 6_001;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches fail-open null values and reports the error once per TTL", async () => {
    let now = 0;
    const onError = vi.fn();
    const load = vi.fn().mockRejectedValue(new Error("redis offline"));
    const cache = createQueueHealthCache(load, { now: () => now, ttlMs: 5_000, onError });

    await expect(cache.get()).resolves.toBeNull();
    await expect(cache.get()).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    now = 5_001;
    await expect(cache.get()).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("recreates a poisoned BullMQ client after Redis recovers", async () => {
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const firstClient = {
      getJobCounts: vi.fn().mockRejectedValue(new Error("redis offline")),
      getJobs: vi.fn(),
      close: firstClose,
    };
    const secondClient = {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, active: 0 }),
      getJobs: vi.fn().mockResolvedValue([{ timestamp: 50_000, opts: { delay: 0 } }]),
      close: secondClose,
    };
    const createClient = vi.fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);
    const reader = createQueueHealthSource(createClient as never);

    await expect(readQueueHealthSnapshot(reader.source, {
      now: () => 100_000,
      warnSeconds: 60,
    })).rejects.toThrow("redis offline");
    await expect(readQueueHealthSnapshot(reader.source, {
      now: () => 100_000,
      warnSeconds: 60,
    })).resolves.toEqual({
      waiting: 1,
      active: 0,
      oldestWaitingSeconds: 50,
      warnSeconds: 60,
    });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(1);

    await reader.close();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});

describe("resolveQueueLagWarnSeconds", () => {
  it.each([undefined, "", "0", "1.5", "86401", "nope"])(
    "falls back for %s",
    (raw) => expect(resolveQueueLagWarnSeconds(raw)).toBe(60),
  );
  it("accepts the closed positive range", () => {
    expect(resolveQueueLagWarnSeconds("1")).toBe(1);
    expect(resolveQueueLagWarnSeconds("86400")).toBe(86_400);
  });
});
