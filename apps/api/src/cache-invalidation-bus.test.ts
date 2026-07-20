import { describe, expect, it, vi } from "vitest";

import { CACHE_INVALIDATION_CHANNEL } from "@janusly/shared";

import {
  createCacheInvalidationBus,
  type CacheInvalidationSubscriber,
} from "./cache-invalidation-bus";

function buildSubscriber(options: { rejectSubscribe?: boolean } = {}) {
  let listener: ((channel: string, message: string) => void) | null = null;
  const subscriber: CacheInvalidationSubscriber = {
    subscribe: vi.fn(async () => {
      if (options.rejectSubscribe) throw new Error("Redis unavailable");
      return 1;
    }),
    on: (_event, nextListener) => {
      listener = nextListener;
      return subscriber;
    },
  };
  return {
    subscriber,
    emit: (channel: string, message: string) => listener?.(channel, message),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cache invalidation bus", () => {
  it("publishes the closed message contract and dispatches both local cache families", async () => {
    const publisher = { publish: vi.fn(async () => 1) };
    const fake = buildSubscriber();
    const invalidateMetrics = vi.fn();
    const invalidateConfig = vi.fn();
    const bus = createCacheInvalidationBus({
      publisher,
      getSubscriber: () => fake.subscriber,
      invalidateRecoveryMetrics: invalidateMetrics,
      invalidateOrgConfig: invalidateConfig,
    });

    await bus.start();
    bus.publish({ kind: "org-config", orgId: "org-a" });
    await flush();

    expect(publisher.publish).toHaveBeenCalledWith(
      CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ kind: "org-config", orgId: "org-a" }),
    );

    fake.emit(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ kind: "recovery-metrics", orgId: "org-a" }));
    fake.emit(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ kind: "org-config", orgId: "org-b" }));
    expect(invalidateMetrics).toHaveBeenCalledWith("org-a");
    expect(invalidateConfig).toHaveBeenCalledWith("org-b");
  });

  it("starts once and ignores malformed, unrelated, and handler-fault payloads", async () => {
    const fake = buildSubscriber();
    const invalidateMetrics = vi.fn(() => { throw new Error("cache fault"); });
    const bus = createCacheInvalidationBus({
      publisher: { publish: vi.fn(async () => 1) },
      getSubscriber: () => fake.subscriber,
      invalidateRecoveryMetrics: invalidateMetrics,
      invalidateOrgConfig: vi.fn(),
    });

    await bus.start();
    await bus.start();
    expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(1);

    expect(() => fake.emit("other-channel", JSON.stringify({ kind: "org-config", orgId: "org-a" }))).not.toThrow();
    expect(() => fake.emit(CACHE_INVALIDATION_CHANNEL, "not json")).not.toThrow();
    expect(() => fake.emit(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ kind: "recovery-metrics", orgId: "org-a" }))).not.toThrow();
    expect(invalidateMetrics).toHaveBeenCalledWith("org-a");
  });

  it("fails open when publishing or initial subscribing cannot reach Redis", async () => {
    const fake = buildSubscriber({ rejectSubscribe: true });
    const bus = createCacheInvalidationBus({
      publisher: { publish: vi.fn(() => Promise.reject(new Error("Redis unavailable"))) },
      getSubscriber: () => fake.subscriber,
      invalidateRecoveryMetrics: vi.fn(),
      invalidateOrgConfig: vi.fn(),
    });

    await expect(bus.start()).resolves.toBeUndefined();
    expect(() => bus.publish({ kind: "recovery-metrics", orgId: "org-a" })).not.toThrow();
    await flush();
  });

  it("retries a failed subscription without attaching duplicate message listeners", async () => {
    let attempts = 0;
    const fake = buildSubscriber();
    fake.subscriber.subscribe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Redis unavailable");
      return 1;
    });
    const invalidateConfig = vi.fn();
    const bus = createCacheInvalidationBus({
      publisher: { publish: vi.fn(async () => 1) },
      getSubscriber: () => fake.subscriber,
      invalidateRecoveryMetrics: vi.fn(),
      invalidateOrgConfig: invalidateConfig,
    });

    await bus.start();
    await bus.start();
    fake.emit(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ kind: "org-config", orgId: "org-a" }));

    expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(invalidateConfig).toHaveBeenCalledTimes(1);
  });
});
