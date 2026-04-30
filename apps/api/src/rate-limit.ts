import { httpError } from "./http";

export type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
};

// The narrow subset of ioredis methods the limiter uses. Lets tests pass a
// fake without instantiating a real client and keeps the production wiring
// trivially substitutable in the future.
export type RateLimitClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, mode?: "NX" | "XX" | "GT" | "LT"): Promise<number>;
  pttl(key: string): Promise<number>;
};

const KEY_PREFIX = "janusly:rate";

export function createRateLimiter(client: RateLimitClient) {
  return async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
    const windowKey = `${KEY_PREFIX}:${options.name}:${key}`;

    let count: number;
    try {
      count = await client.incr(windowKey);
      // Always attempt PEXPIRE with the NX flag: on a freshly-created key it
      // sets the window-from-first-hit TTL; on a key that already has a TTL
      // it's a server-side no-op so the window does not extend. The NX flag
      // also recovers from the rare race where a prior PEXPIRE failed after
      // a successful INCR — without it the key would persist with no TTL
      // until manual eviction.
      await client.pexpire(windowKey, options.windowMs, "NX");
    } catch (error) {
      // Fail open: AI surfaces stay available during a Redis blip; the
      // alternative (fail-closed) means full AI outage on transient Redis
      // errors, which is strictly worse user experience for a soft cost-
      // control mechanism. Logged so an operator can see it in stdout.
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
      throw httpError(
        `Rate limit exceeded for ${options.name}. Retry in ${retryAfterSec}s.`,
        429,
      );
    }
  };
}

let productionLimiter: ReturnType<typeof createRateLimiter> | null = null;

async function getProductionRateLimiter() {
  if (!productionLimiter) {
    const { redis } = await import("./redis");
    productionLimiter = createRateLimiter(redis);
  }
  return productionLimiter;
}

// Production wiring is lazy so tests importing `createRateLimiter` can use a
// fake client without opening a real Redis connection as an import side effect.
export async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
  const limiter = await getProductionRateLimiter();
  await limiter(key, options);
}
