import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCachedRecoveryMetrics,
  setCachedRecoveryMetrics,
  invalidateRecoveryMetricsCache,
} from "./metrics-cache";

const priorTtl = process.env.JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS;

afterEach(() => {
  vi.useRealTimers();
  if (priorTtl === undefined) delete process.env.JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS;
  else process.env.JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS = priorTtl;
});

describe("recovery metrics micro-cache", () => {
  it("returns the stored envelope within the TTL", () => {
    const org = `org-hit-${Math.trunc(performance.now())}`;
    setCachedRecoveryMetrics(org, 30, { mttrSeconds: 42 });
    expect(getCachedRecoveryMetrics(org, 30)).toEqual({ mttrSeconds: 42 });
  });

  it("isolates entries by windowDays", () => {
    const org = `org-window-${Math.trunc(performance.now())}`;
    setCachedRecoveryMetrics(org, 7, { w: 7 });
    setCachedRecoveryMetrics(org, 30, { w: 30 });
    expect(getCachedRecoveryMetrics(org, 7)).toEqual({ w: 7 });
    expect(getCachedRecoveryMetrics(org, 30)).toEqual({ w: 30 });
    expect(getCachedRecoveryMetrics(org, 90)).toBeNull();
  });

  it("drops every window for an org on invalidate", () => {
    const org = `org-inval-${Math.trunc(performance.now())}`;
    setCachedRecoveryMetrics(org, 7, { w: 7 });
    setCachedRecoveryMetrics(org, 30, { w: 30 });
    invalidateRecoveryMetricsCache(org);
    expect(getCachedRecoveryMetrics(org, 7)).toBeNull();
    expect(getCachedRecoveryMetrics(org, 30)).toBeNull();
  });

  it("expires entries after the TTL window", () => {
    vi.useFakeTimers();
    const org = `org-exp-${Math.trunc(performance.now())}`;
    setCachedRecoveryMetrics(org, 30, { v: 1 });
    expect(getCachedRecoveryMetrics(org, 30)).toEqual({ v: 1 });
    vi.advanceTimersByTime(30_001);
    expect(getCachedRecoveryMetrics(org, 30)).toBeNull();
  });

  it("is a no-op read/write when disabled via TTL=0", () => {
    process.env.JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS = "0";
    const org = `org-off-${Math.trunc(performance.now())}`;
    setCachedRecoveryMetrics(org, 30, { v: 1 });
    expect(getCachedRecoveryMetrics(org, 30)).toBeNull();
  });
});
