/**
 * Worker-side Redis PUBLISH client for live-run streaming. Separate from the
 * BullMQ connection in `queue.ts` (which needs `maxRetriesPerRequest: null`)
 * and from the rate-limit client — PUBLISH is a normal command and should
 * fail fast / fail-soft during a Redis blip rather than pin the worker.
 *
 * The worker is the primary `run_events` writer (every node lifecycle event +
 * the terminal status flips), so this registration is load-bearing for the
 * SSE stream: without it, a browser watching a run would only see the few
 * events the API process emits (`run.started` / `run.cancelled`).
 *
 * Used by `packages/engine/src/worker.ts` boot + graceful shutdown.
 *
 * Invariants:
 * - Channel name + message shape come from `createRedisRunEventPublisher`
 *   (the engine seam factory) so the worker publisher, the API publisher, and
 *   the API subscriber never drift.
 * - Publish is fire-and-forget and never throws (the factory guards).
 */

import IORedis from "ioredis";

import { getRunMetadata } from "./persistence";
import { createRedisRunEventPublisher, setRunEventPublisher } from "./run-event-stream";

let redis: IORedis | null = null;

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

/** Register the worker's Redis-backed run-event publisher. Call once at boot. */
export function registerWorkerRunEventPublisher(): void {
  setRunEventPublisher(
    createRedisRunEventPublisher({
      publish: (channel, message) => getRedis().publish(channel, message),
      resolveOrgId: (runId) => getRunMetadata(runId).then((meta) => meta?.orgId ?? null),
    }),
  );
}

/** Close the worker's PUBLISH client during graceful shutdown. */
export async function closeWorkerRunEventRedis(): Promise<void> {
  const client = redis;
  redis = null;
  if (client) {
    await client.quit();
  }
}
