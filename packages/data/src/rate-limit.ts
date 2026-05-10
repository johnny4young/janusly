/**
 * Shared Redis-backed rate limiter primitive. Callers provide the Redis-like
 * client; this module owns the counter semantics (`INCR` + `PEXPIRE NX`),
 * over-limit error shape, and fail-open behavior.
 *
 * Used by:
 * - `apps/api/src/rate-limit.ts` — request-path API buckets.
 * - `packages/engine/src/rate-limit-redis.ts` — worker-side tool buckets.
 *
 * Invariants:
 * - State is shared by Redis keys, not process memory, so API replicas and
 *   workers observe the same bucket.
 * - Redis errors fail open with a `[rate-limit]` warning.
 * - The first hit sets the window TTL; subsequent hits must not extend it.
 */

/** Per-call rate-limit configuration. `name` namespaces the Redis key. */
export type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
};

/** Narrow Redis surface the limiter needs. Tests can inject a fake. */
export type RateLimitClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, mode?: "NX" | "XX" | "GT" | "LT"): Promise<number>;
  pttl(key: string): Promise<number>;
};

export type RateLimitError = Error & { statusCode?: number };

const KEY_PREFIX = "janusly:rate";

function rateLimitError(message: string, statusCode: number): RateLimitError {
  const err = new Error(message) as RateLimitError;
  err.statusCode = statusCode;
  return err;
}

/**
 * Bind a Redis-like client and return a per-call limiter. Throws a
 * status-bearing 429 when the bucket is exhausted.
 */
export function createRateLimiter(client: RateLimitClient) {
  return async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
    const windowKey = `${KEY_PREFIX}:${options.name}:${key}`;

    let count: number;
    try {
      count = await client.incr(windowKey);
      await client.pexpire(windowKey, options.windowMs, "NX");
    } catch (error) {
      console.warn(`[rate-limit] redis error for ${options.name}, failing open`, error);
      return;
    }

    if (count > options.max) {
      let ttlMs = options.windowMs;
      try {
        const reported = await client.pttl(windowKey);
        if (reported > 0) ttlMs = reported;
      } catch {
        // Falling back to the configured window is fine.
      }
      const retryAfterSec = Math.max(1, Math.ceil(ttlMs / 1000));
      throw rateLimitError(
        `Rate limit exceeded for ${options.name}. Retry in ${retryAfterSec}s.`,
        429,
      );
    }
  };
}
