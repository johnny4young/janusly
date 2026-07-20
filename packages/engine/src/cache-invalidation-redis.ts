/**
 * Worker-side Redis subscription for tenant cache invalidations.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — starts before scheduler and node work,
 *   then closes after in-flight jobs drain.
 *
 * Invariants:
 * - Workers only hold the org-config cache; recovery metrics live in API
 *   processes, so recovery-metrics messages are intentionally ignored here.
 * - Redis is best-effort. If subscribing fails, worker reads continue and
 *   the org-config TTL remains the bounded staleness fallback.
 */

import IORedis from "ioredis";

import {
  CACHE_INVALIDATION_CHANNEL,
  parseCacheInvalidationMessage,
} from "@janusly/shared";
import { invalidateOrgConfigCache } from "@janusly/data";

let subscriber: IORedis | null = null;

/** Minimal Redis subscriber surface used by the worker invalidation listener. */
export type WorkerCacheInvalidationSubscriber = {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
};

/** Apply one raw cache invalidation payload to the worker's local caches. */
export function handleWorkerCacheInvalidation(raw: string): void {
  const message = parseCacheInvalidationMessage(raw);
  if (message?.kind === "org-config") invalidateOrgConfigCache(message.orgId);
}

/** Attach best-effort worker cache handling to a Redis subscriber connection. */
export function subscribeWorkerCacheInvalidations(client: WorkerCacheInvalidationSubscriber): void {
  client.on("message", (channel, raw) => {
    if (channel !== CACHE_INVALIDATION_CHANNEL) return;
    try {
      handleWorkerCacheInvalidation(raw);
    } catch {
      // Cache eviction is best-effort; an implementation fault must not stop jobs.
    }
  });
  void client.subscribe(CACHE_INVALIDATION_CHANNEL).catch(() => {});
}

/** Start one dedicated worker subscriber for cross-replica config invalidations. */
export function startWorkerCacheInvalidationSubscriber(): void {
  if (subscriber) return;
  const client = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on("error", () => {});
  subscriber = client;
  subscribeWorkerCacheInvalidations(client);
}

/** Close the worker's dedicated invalidation subscriber during shutdown. */
export async function closeWorkerCacheInvalidationSubscriber(): Promise<void> {
  const client = subscriber;
  subscriber = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
