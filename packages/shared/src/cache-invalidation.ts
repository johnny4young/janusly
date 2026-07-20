/**
 * Cache-invalidation message contract shared by API and worker replicas.
 *
 * Used by:
 * - `apps/api/src/cache-invalidation-bus.ts` — publishes and handles API caches.
 * - `packages/engine/src/cache-invalidation-redis.ts` — clears worker-side
 *   org-config snapshots.
 *
 * Invariants:
 * - Messages carry only a closed cache kind and an org id; they never contain
 *   configuration values, credentials, or operator data.
 * - Consumers must treat malformed payloads as no-ops so the TTL remains a
 *   safe convergence fallback during Redis faults or mixed-version rollouts.
 */

/** Redis channel carrying best-effort cache invalidations between replicas. */
export const CACHE_INVALIDATION_CHANNEL = "janusly:cache:invalidate";

/** The bounded set of process-local cache families that can be invalidated. */
export const cacheInvalidationKinds = ["recovery-metrics", "org-config"] as const;

/** A cache family supported by the invalidation channel. */
export type CacheInvalidationKind = (typeof cacheInvalidationKinds)[number];

/** A tenant-scoped cache invalidation sent after a successful mutation. */
export type CacheInvalidationMessage = {
  kind: CacheInvalidationKind;
  orgId: string;
};

/** Parse an untrusted Redis payload into a safe cache invalidation, or reject it. */
export function parseCacheInvalidationMessage(raw: string): CacheInvalidationMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { kind, orgId } = parsed as Record<string, unknown>;
  if (typeof orgId !== "string" || !orgId) return null;
  if (kind !== "recovery-metrics" && kind !== "org-config") return null;
  return { kind, orgId };
}
