/**
 * Tests for the shared rate-limiter primitive.
 *
 * The load-bearing invariant: ``createRateLimiter`` fails OPEN on Redis
 * errors. Any change to the hooks plumbing MUST preserve this.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRateLimiter,
  type RateLimitClient,
  type RateLimiterHooks,
} from "./rate-limit";

function makeClient(overrides: Partial<RateLimitClient> = {}): RateLimitClient {
  return {
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn().mockResolvedValue(60_000),
    ...overrides,
  };
}

describe("createRateLimiter — fail-open invariant", () => {
  it("returns without throwing when INCR rejects", async () => {
    const limiter = createRateLimiter(
      makeClient({
        incr: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns without throwing when PEXPIRE rejects", async () => {
    const limiter = createRateLimiter(
      makeClient({
        pexpire: vi.fn().mockRejectedValue(new Error("OOM")),
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 }),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createRateLimiter — observability hooks", () => {
  // The typed `vi.fn<…>()` overload pins the hook signature so the
  // assignment into `RateLimiterHooks` survives `tsc --noEmit`. Bare
  // `vi.fn()` returns the over-broad `Mock<Procedure | Constructable>`
  // that the strict hook union doesn't accept.
  let onRedisError: ReturnType<typeof vi.fn<NonNullable<RateLimiterHooks["onRedisError"]>>>;
  let onRedisSuccess: ReturnType<typeof vi.fn<NonNullable<RateLimiterHooks["onRedisSuccess"]>>>;
  let hooks: RateLimiterHooks;

  beforeEach(() => {
    onRedisError = vi.fn<NonNullable<RateLimiterHooks["onRedisError"]>>();
    onRedisSuccess = vi.fn<NonNullable<RateLimiterHooks["onRedisSuccess"]>>();
    hooks = { onRedisError, onRedisSuccess };
  });

  it("fires onRedisSuccess on a healthy round-trip", async () => {
    const limiter = createRateLimiter(makeClient(), hooks);
    await limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 });
    expect(onRedisSuccess).toHaveBeenCalledWith("ai", "org-1");
    expect(onRedisError).not.toHaveBeenCalled();
  });

  it("fires onRedisError with the bucket + key + original error", async () => {
    const boom = new Error("ECONNREFUSED");
    const limiter = createRateLimiter(
      makeClient({ incr: vi.fn().mockRejectedValue(boom) }),
      hooks,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 });
    } finally {
      warn.mockRestore();
    }
    expect(onRedisError).toHaveBeenCalledWith("ai", "org-1", boom);
    expect(onRedisSuccess).not.toHaveBeenCalled();
  });

  it("still fires onRedisSuccess on a 429 (the Redis round-trip itself succeeded)", async () => {
    const limiter = createRateLimiter(
      // count > max immediately triggers 429.
      makeClient({ incr: vi.fn().mockResolvedValue(11), pttl: vi.fn().mockResolvedValue(30_000) }),
      hooks,
    );
    await expect(
      limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 }),
    ).rejects.toThrow(/Rate limit exceeded/);
    expect(onRedisSuccess).toHaveBeenCalledWith("ai", "org-1");
    expect(onRedisError).not.toHaveBeenCalled();
  });

  it("survives a throwing hook — fail-open invariant preserved", async () => {
    const limiter = createRateLimiter(
      makeClient({ incr: vi.fn().mockRejectedValue(new Error("boom")) }),
      {
        onRedisError: () => {
          throw new Error("hook bug");
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 }),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not await async hook rejections (limiter return time unaffected)", async () => {
    const slowHook = vi.fn().mockReturnValue(Promise.reject(new Error("network slow")));
    const limiter = createRateLimiter(makeClient(), { onRedisSuccess: slowHook });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        limiter("org-1", { name: "ai", windowMs: 60_000, max: 10 }),
      ).resolves.toBeUndefined();
      expect(slowHook).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
