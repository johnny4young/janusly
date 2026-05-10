/**
 * Tests for the engine-side rate-limit DI seam. The seam exists so the
 * engine can call into a host-process limiter (API or worker)
 * without a hard dependency on `apps/api/src/rate-limit.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetEngineRateLimiterForTests,
  getEngineRateLimiter,
  setEngineRateLimiter,
  type EngineRateLimitChecker,
} from "./rate-limit";

afterEach(() => {
  _resetEngineRateLimiterForTests();
});

describe("engine rate-limit DI seam", () => {
  it("returns null when no limiter is registered", () => {
    expect(getEngineRateLimiter()).toBeNull();
  });

  it("returns the registered limiter", async () => {
    const fake: EngineRateLimitChecker = vi.fn(async () => undefined);
    setEngineRateLimiter(fake);
    const limiter = getEngineRateLimiter();
    expect(limiter).toBe(fake);
    await limiter?.("email.send", "org-1", { windowMs: 60_000, max: 100 });
    expect(fake).toHaveBeenCalledWith("email.send", "org-1", { windowMs: 60_000, max: 100 });
  });

  it("`_resetEngineRateLimiterForTests` clears the registry", () => {
    setEngineRateLimiter(async () => undefined);
    expect(getEngineRateLimiter()).not.toBeNull();
    _resetEngineRateLimiterForTests();
    expect(getEngineRateLimiter()).toBeNull();
  });

  it("setEngineRateLimiter(null) clears the registry", () => {
    setEngineRateLimiter(async () => undefined);
    setEngineRateLimiter(null);
    expect(getEngineRateLimiter()).toBeNull();
  });
});
