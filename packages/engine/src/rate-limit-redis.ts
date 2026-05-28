/**
 * Bounded Redis client for worker-side rate-limit buckets. Separate from the
 * BullMQ connection in `queue.ts`: BullMQ needs `maxRetriesPerRequest: null`,
 * while rate limiting must fail open quickly during Redis blips.
 *
 * Used by `worker.ts` to inject the shared Redis-backed limiter into
 * `setEngineRateLimiter`, so tools executed in the worker (including
 * `email.send`) observe the same per-org buckets as API request paths.
 *
 * Invariants:
 * - Do not reuse the BullMQ connection here; it can retry forever.
 * - Close this client during worker shutdown after `worker.close()`.
 */

import IORedis from "ioredis";
import { loadRootEnv } from "@janusly/db";
import {
  createRateLimiter,
  type RateLimitOptions,
  recordRateLimiterError,
  recordRateLimiterRecovery,
} from "@janusly/data";

loadRootEnv();

let redis: IORedis | null = null;
let limiter: ReturnType<typeof createRateLimiter> | null = null;

function getRedis(): IORedis {
  if (redis) return redis;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("Missing REDIS_URL. Add it to .env or .env.example.");
  }
  redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  return redis;
}

function getLimiter(): ReturnType<typeof createRateLimiter> {
  if (!limiter) {
    // Worker-side hooks mirror the API wiring so engine Redis blips
    // (during email / integration / MCP tool calls) flow into the
    // SAME process-local degradation tracker the API replicas use.
    // The snapshot is per-process — operators polling each replica's
    // ``/health`` see that replica's view.
    limiter = createRateLimiter(getRedis(), {
      onRedisError: recordRateLimiterError,
      onRedisSuccess: recordRateLimiterRecovery,
    });
  }
  return limiter;
}

/** Worker-side Redis rate-limit gate. Throws 429 when over limit. */
export async function enforceWorkerRateLimit(key: string, options: RateLimitOptions): Promise<void> {
  await getLimiter()(key, options);
}

/** Close the worker's bounded Redis client during graceful shutdown. */
export async function closeWorkerRateLimitRedis(): Promise<void> {
  const client = redis;
  redis = null;
  limiter = null;
  if (client) {
    await client.quit();
  }
}
