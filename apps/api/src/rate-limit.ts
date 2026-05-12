/**
 * Redis-backed rate limiter. Counts hits per `(name, key)` in a
 * sliding window via `INCR` + `PEXPIRE NX`; throws 429 (`HttpError`) when
 * the count exceeds `max`. Fails OPEN on Redis errors with a `[rate-limit]`
 * warn — an AI Studio outage during a Redis blip is worse UX than a brief
 * over-limit window. The DI seam (`createRateLimiter(client)`) lets tests
 * inject a fake without opening a real Redis connection.
 *
 * Used by `apps/api/src/routes/ai-routes.ts` `/ai/*` routes, `apps/api/src/index.ts`
 * engine DI wiring, and any other surface that wants to gate by org / user.
 *
 * Invariants:
 * - **Fail open** on Redis errors (AGENTS.md). Don't change to fail-closed
 *   without wide signoff — it converts cache outages into product outages.
 * - `PEXPIRE` uses `NX` so the window doesn't extend when the key was
 *   already created and TTL'd by a prior INCR.
 * - Production wiring is lazy (`getProductionRateLimiter`) so importing
 *   this module doesn't open a Redis connection as a side effect.
 */

import { createRateLimiter, type RateLimitOptions } from "@janusly/data/src/rate-limit";

export {
  createRateLimiter,
  type RateLimitClient,
  type RateLimitOptions,
} from "@janusly/data/src/rate-limit";

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
/** Production rate-limit gate — lazily resolves the singleton against `./redis.ts`. */
export async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<void> {
  const limiter = await getProductionRateLimiter();
  await limiter(key, options);
}
