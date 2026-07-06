/**
 * Process-local micro-cache for the composed `/recovery/metrics` envelope.
 *
 * The metrics rollup fans out ~8 signal queries (each capped at up to 10k
 * rows) plus the org-config snapshot. With several operators watching the
 * Recovery Center, identical polls re-ran that fan-out every time. This caches
 * the composed envelope per `(orgId, windowDays)` for a short TTL.
 *
 * Used by:
 * - `apps/api/src/routes/recovery-routes.ts` — read-through on `GET /recovery/metrics`.
 * - `apps/api/src/routes/dlq-routes.ts` — `invalidateRecoveryMetricsCache(orgId)`
 *   after replay/resolve mutations so the dashboard reflects them immediately.
 *
 * Bounds:
 * - TTL via `JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS` (default 30_000; `0` disables).
 * - Capped at `MAX_ORGS` orgs with FIFO eviction; each org holds one entry
 *   per distinct `windowDays` it was queried with.
 * - The staleness ceiling is the TTL even without an explicit invalidation, so
 *   a signal this module doesn't know about (e.g. an approval resuming) still
 *   converges within one window.
 */

type MetricsCacheEntry = { value: unknown; expiresAt: number };

const CACHE = new Map<string, Map<number, MetricsCacheEntry>>();
const MAX_ORGS = 500;

function ttlMs(): number {
  const raw = Number(process.env.JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/** Return the cached metrics envelope for `(orgId, windowDays)`, or `null` on miss/expiry/disabled. */
export function getCachedRecoveryMetrics(orgId: string, windowDays: number): unknown | null {
  if (ttlMs() <= 0) return null;
  const perOrg = CACHE.get(orgId);
  const hit = perOrg?.get(windowDays);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    perOrg!.delete(windowDays);
    return null;
  }
  return hit.value;
}

/** Store a composed metrics envelope. No-op when the cache is disabled (TTL 0). */
export function setCachedRecoveryMetrics(orgId: string, windowDays: number, value: unknown): void {
  const ttl = ttlMs();
  if (ttl <= 0) return;
  let perOrg = CACHE.get(orgId);
  if (!perOrg) {
    if (CACHE.size >= MAX_ORGS) {
      const oldest = CACHE.keys().next().value;
      if (oldest !== undefined) CACHE.delete(oldest);
    }
    perOrg = new Map();
    CACHE.set(orgId, perOrg);
  }
  perOrg.set(windowDays, { value, expiresAt: Date.now() + ttl });
}

/** Drop all cached windows for an org — called after a DLQ mutation; exported for tests. */
export function invalidateRecoveryMetricsCache(orgId: string): void {
  CACHE.delete(orgId);
}
