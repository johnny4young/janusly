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

/**
 * Optional observability hooks fired on every limiter call. Both are
 * best-effort: any throw from a hook is caught and logged, so the
 * limiter's fail-open invariant survives a buggy or unavailable
 * observability layer.
 *
 * - ``onRedisError`` fires when ``INCR`` or ``PEXPIRE NX`` rejects.
 *   The limiter still returns successfully (fail-open) after the
 *   hook runs.
 * - ``onRedisSuccess`` fires after a healthy ``INCR + PEXPIRE NX``
 *   round-trip. Production wiring uses this to flip a previously-
 *   degraded bucket back to healthy.
 */
export type RateLimiterHooks = {
  onRedisError?: (bucket: string, key: string, error: unknown) => void | Promise<void>;
  onRedisSuccess?: (bucket: string, key: string) => void | Promise<void>;
};

export type RateLimitError = Error & { statusCode?: number };

const KEY_PREFIX = "janusly:rate";

function rateLimitError(message: string, statusCode: number): RateLimitError {
  const err = new Error(message) as RateLimitError;
  err.statusCode = statusCode;
  return err;
}

function fireHook(
  hook: ((bucket: string, key: string, error?: unknown) => void | Promise<void>) | undefined,
  bucket: string,
  key: string,
  error?: unknown,
): void {
  if (!hook) return;
  try {
    // Only forward the third arg when we actually have an error so the
    // public hook types (``onRedisSuccess: (bucket, key) => …`` vs
    // ``onRedisError: (bucket, key, error) => …``) match the call shape.
    const result = error === undefined ? hook(bucket, key) : hook(bucket, key, error);
    // Hooks may be async; we don't await them. A rejection becomes an
    // unhandled rejection — catch it explicitly so the limiter's
    // fail-open invariant doesn't depend on the hook's async hygiene.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch((err) => {
        console.warn(`[rate-limit] hook async rejection for ${bucket}`, err);
      });
    }
  } catch (err) {
    console.warn(`[rate-limit] hook threw for ${bucket}`, err);
  }
}

/**
 * Bind a Redis-like client and return a per-call limiter. Throws a
 * status-bearing 429 when the bucket is exhausted.
 *
 * The optional ``hooks`` argument carries observability callbacks
 * fired on every Redis success / error. See ``RateLimiterHooks``.
 * Both hooks are wrapped in ``try/catch`` — a hook bug NEVER breaks
 * the fail-open invariant.
 */
export function createRateLimiter(client: RateLimitClient, hooks?: RateLimiterHooks) {
  return async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
    const windowKey = `${KEY_PREFIX}:${options.name}:${key}`;

    let count: number;
    try {
      count = await client.incr(windowKey);
      await client.pexpire(windowKey, options.windowMs, "NX");
    } catch (error) {
      fireHook(hooks?.onRedisError, options.name, key, error);
      console.warn(`[rate-limit] redis error for ${options.name}, failing open`, error);
      return;
    }

    // Successful Redis round-trip — the bucket is healthy. Hook fires
    // BEFORE the over-limit check so a 429-throwing call still counts
    // as a "Redis worked" signal.
    fireHook(hooks?.onRedisSuccess, options.name, key);

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
