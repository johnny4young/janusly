/**
 * Single ioredis client for the API's request-path operations (currently
 * the rate limiter). Separate from `packages/engine/src/queue.ts`'s BullMQ
 * connection: BullMQ sets `maxRetriesPerRequest: null` (BullMQ retries
 * blocking commands itself) which is wrong for a request-path client where
 * a sick Redis would pin a request indefinitely.
 *
 * Used by `rate-limit.ts:getProductionRateLimiter`.
 *
 * Invariants:
 * - Bounded retries (`maxRetriesPerRequest: 3`) so a Redis blip surfaces
 *   as a fail-open warn rather than a hung request.
 */

import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

/** Singleton ioredis client for request-path operations. Don't reuse for BullMQ. */
export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});
