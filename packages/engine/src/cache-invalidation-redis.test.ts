import { describe, expect, it, vi } from "vitest";

import { CACHE_INVALIDATION_CHANNEL } from "@janusly/shared";

const { invalidateOrgConfigCache } = vi.hoisted(() => ({
  invalidateOrgConfigCache: vi.fn(),
}));

vi.mock("@janusly/data", () => ({ invalidateOrgConfigCache }));

import {
  handleWorkerCacheInvalidation,
  subscribeWorkerCacheInvalidations,
  type WorkerCacheInvalidationSubscriber,
} from "./cache-invalidation-redis";

function buildSubscriber() {
  let listener: ((channel: string, message: string) => void) | null = null;
  const subscriber: WorkerCacheInvalidationSubscriber = {
    subscribe: vi.fn(async () => 1),
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

describe("worker cache invalidation", () => {
  it("clears only its org-config cache for a valid config message", () => {
    handleWorkerCacheInvalidation(JSON.stringify({ kind: "org-config", orgId: "org-worker" }));
    expect(invalidateOrgConfigCache).toHaveBeenCalledWith("org-worker");
  });

  it("ignores recovery-metrics and malformed messages without touching worker config", () => {
    invalidateOrgConfigCache.mockClear();
    expect(() => handleWorkerCacheInvalidation(JSON.stringify({ kind: "recovery-metrics", orgId: "org-worker" }))).not.toThrow();
    expect(() => handleWorkerCacheInvalidation("not json")).not.toThrow();
    expect(invalidateOrgConfigCache).not.toHaveBeenCalled();
  });

  it("subscribes once and handles only messages from the cache channel", () => {
    invalidateOrgConfigCache.mockClear();
    const fake = buildSubscriber();
    subscribeWorkerCacheInvalidations(fake.subscriber);

    expect(fake.subscriber.subscribe).toHaveBeenCalledWith(CACHE_INVALIDATION_CHANNEL);
    fake.emit("other-channel", JSON.stringify({ kind: "org-config", orgId: "org-other" }));
    fake.emit(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ kind: "org-config", orgId: "org-worker" }));

    expect(invalidateOrgConfigCache).toHaveBeenCalledWith("org-worker");
    expect(invalidateOrgConfigCache).not.toHaveBeenCalledWith("org-other");
  });
});
