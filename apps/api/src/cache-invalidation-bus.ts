/**
 * API-side Redis invalidation bridge for process-local tenant caches.
 *
 * Used by:
 * - `apps/api/src/index.ts` — injects runtime dependencies and starts the
 *   shared subscriber at API boot.
 * - `apps/api/src/dlq.ts` — publishes recovery-metrics invalidations.
 * - `apps/api/src/routes/org-routes.ts` — publishes org-config invalidations.
 *
 * Invariants:
 * - Publishing and subscribing are best-effort: a Redis failure leaves the
 *   existing TTL as the convergence ceiling and never breaks a mutation.
 * - This module has no Redis or data-layer imports. Route modules can publish
 *   without opening a network connection during tests; API boot injects the
 *   runtime dependencies.
 * - The injected API subscriber is the dedicated run-stream connection. Its
 *   owner (`closeRunStreamHub`) closes it during graceful shutdown.
 * - Redis echoes a published message to this replica too; duplicate cache
 *   clears are idempotent and deliberately harmless.
 */

import {
  CACHE_INVALIDATION_CHANNEL,
  parseCacheInvalidationMessage,
  type CacheInvalidationMessage,
} from "@janusly/shared";

export type CacheInvalidationPublisher = {
  publish(channel: string, message: string): Promise<unknown>;
};

export type CacheInvalidationSubscriber = {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
};

export type CacheInvalidationBus = {
  /** Publish a best-effort tenant cache invalidation. */
  publish(message: CacheInvalidationMessage): void;
  /** Subscribe this replica to invalidations. Safe to call more than once. */
  start(): Promise<void>;
};

export type CacheInvalidationBusOptions = {
  publisher: CacheInvalidationPublisher;
  getSubscriber: () => CacheInvalidationSubscriber;
  invalidateRecoveryMetrics: (orgId: string) => void;
  invalidateOrgConfig: (orgId: string) => void;
};

/** Build a testable API cache-invalidation bus over Redis pub/sub. */
export function createCacheInvalidationBus(options: CacheInvalidationBusOptions): CacheInvalidationBus {
  let started = false;
  let subscriber: CacheInvalidationSubscriber | null = null;
  let listenerAttached = false;

  return {
    publish(message) {
      void options.publisher.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(message)).catch(() => {});
    },
    async start() {
      if (started) return;
      if (!subscriber) {
        try {
          subscriber = options.getSubscriber();
        } catch {
          return;
        }
      }

      if (!listenerAttached) {
        subscriber.on("message", (channel, raw) => {
          if (channel !== CACHE_INVALIDATION_CHANNEL) return;
          const message = parseCacheInvalidationMessage(raw);
          if (!message) return;
          try {
            if (message.kind === "recovery-metrics") options.invalidateRecoveryMetrics(message.orgId);
            else options.invalidateOrgConfig(message.orgId);
          } catch {
            // A local cache implementation must never make the pub/sub bridge fatal.
          }
        });
        listenerAttached = true;
      }

      try {
        await subscriber.subscribe(CACHE_INVALIDATION_CHANNEL);
        started = true;
      } catch {
        // A later explicit start can retry. Until then, cache TTLs remain the
        // bounded-staleness fallback.
      }
    },
  };
}

let cacheInvalidationBus: CacheInvalidationBus | null = null;

/** Configure the production singleton during API boot, before it is started. */
export function configureCacheInvalidationBus(options: CacheInvalidationBusOptions): void {
  cacheInvalidationBus ??= createCacheInvalidationBus(options);
}

/** Publish a best-effort cache invalidation after a successful API mutation. */
export function publishCacheInvalidation(message: CacheInvalidationMessage): void {
  cacheInvalidationBus?.publish(message);
}

/** Start API cache invalidation handling at boot. */
export function startCacheInvalidationSubscriber(): void {
  void cacheInvalidationBus?.start();
}
