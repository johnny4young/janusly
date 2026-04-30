import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimitClient } from "./rate-limit";

type FakeRedis = RateLimitClient & {
  __counts: Map<string, number>;
  __ttls: Map<string, number>;
  __setError(error: Error | null): void;
};

function buildFakeRedis(): FakeRedis {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  let pendingError: Error | null = null;

  const incr = async (key: string) => {
    if (pendingError) throw pendingError;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  const pexpire = async (key: string, ms: number, mode?: "NX" | "XX" | "GT" | "LT") => {
    if (pendingError) throw pendingError;
    if (mode === "NX" && ttls.has(key)) return 0; // no-op when TTL already set
    ttls.set(key, ms);
    return 1;
  };
  const pttl = async (key: string) => {
    if (pendingError) throw pendingError;
    return ttls.get(key) ?? -1;
  };

  return {
    __counts: counts,
    __ttls: ttls,
    __setError(error) {
      pendingError = error;
    },
    incr,
    pexpire,
    pttl,
  };
}

describe("rate limiter (Redis-backed)", () => {
  it("allows up to `max` requests in a window, then throws 429", async () => {
    const redis = buildFakeRedis();
    const enforce = createRateLimiter(redis);

    for (let i = 0; i < 3; i++) {
      await enforce("org-A", { name: "ai", windowMs: 60_000, max: 3 });
    }
    await expect(
      enforce("org-A", { name: "ai", windowMs: 60_000, max: 3 }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("isolates counts per org key", async () => {
    const redis = buildFakeRedis();
    const enforce = createRateLimiter(redis);

    await enforce("org-A", { name: "ai", windowMs: 60_000, max: 1 });
    // org-B still has the full quota.
    await expect(
      enforce("org-B", { name: "ai", windowMs: 60_000, max: 1 }),
    ).resolves.toBeUndefined();
    // org-A is exhausted.
    await expect(
      enforce("org-A", { name: "ai", windowMs: 60_000, max: 1 }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("shares state across multiple API processes via the same Redis", async () => {
    // Two `createRateLimiter` instances bound to the SAME backing store —
    // models two API replicas hitting one Redis. The second replica must see
    // the count incremented by the first.
    const redis = buildFakeRedis();
    const replicaA = createRateLimiter(redis);
    const replicaB = createRateLimiter(redis);

    await replicaA("org-A", { name: "ai", windowMs: 60_000, max: 2 });
    await replicaB("org-A", { name: "ai", windowMs: 60_000, max: 2 });
    // Third call from either replica must trip the limit — proves it's
    // counting across replicas, not per-replica.
    await expect(
      replicaA("org-A", { name: "ai", windowMs: 60_000, max: 2 }),
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      replicaB("org-A", { name: "ai", windowMs: 60_000, max: 2 }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("includes a Retry-After hint derived from the remaining TTL", async () => {
    const redis = buildFakeRedis();
    const enforce = createRateLimiter(redis);

    // Trip the limit; the next call returns the throttle error with a window-
    // sized retry hint (the fake's PTTL returns the configured windowMs).
    await enforce("org-A", { name: "ai", windowMs: 30_000, max: 1 });
    await expect(
      enforce("org-A", { name: "ai", windowMs: 30_000, max: 1 }),
    ).rejects.toMatchObject({
      statusCode: 429,
      message: expect.stringContaining("Retry in 30s"),
    });
  });

  it("fails open when Redis throws", async () => {
    const redis = buildFakeRedis();
    const enforce = createRateLimiter(redis);
    redis.__setError(new Error("connection lost"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Even at max=1, a Redis error must not block the request — fail-open
    // semantics are documented in AGENTS.md and the rate-limit module comment.
    await expect(
      enforce("org-A", { name: "ai", windowMs: 60_000, max: 1 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[rate-limit]");

    warn.mockRestore();
  });
});
