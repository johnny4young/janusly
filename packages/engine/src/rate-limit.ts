/**
 * Process-global rate-limit DI seam for engine-side write-side tools
 * (today: `email.send`; tomorrow: any other external write tool that
 * needs per-org throttling). The actual Redis-backed limiter lives in
 * `apps/api/src/rate-limit.ts` and the engine can't import it
 * directly without inverting the dependency graph.
 *
 * Mirror the `setUsageRecorder` pattern: host processes that can
 * provide a limiter call `setEngineRateLimiter(...)` to inject the
 * real implementation. The API process and worker both wire Redis-backed
 * limiters through this seam. Tests register a fake. When unset (e.g.
 * focused unit tests), `getEngineRateLimiter()` returns `null` and the
 * calling tool no-ops the gate.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setEngineRateLimiter(enforceRateLimit)`.
 * - `packages/engine/src/worker.ts` — boot path: `setEngineRateLimiter(enforceWorkerRateLimit)`.
 * - `packages/engine/src/tool-registry.ts:email.send` — gates the send.
 *
 * Invariants:
 * - The injected fn is responsible for THROWING when over limit (the
 *   existing `enforceRateLimit` already does). The tool wrapper
 *   converts the throw to a `{ ok: false, error }` envelope to
 *   satisfy the AI-fallback contract.
 * - Fail-open is the existing Redis-blip behaviour: a Redis outage does
 *   NOT block the tool.
 */

/**
 * Function shape: per-org enforcement. Throws when over limit.
 * `windowMs` is the bucket TTL; `max` is the cap inside the window.
 * Bucket name namespaces multiple consumers (e.g. `"email.send"`
 * vs `"ai"` vs future tools).
 */
export type EngineRateLimitChecker = (
  bucket: string,
  orgId: string,
  options: { windowMs: number; max: number },
) => Promise<void>;

let checker: EngineRateLimitChecker | null = null;

/** Register the process-global rate limiter. Pass `null` to disable. */
export function setEngineRateLimiter(fn: EngineRateLimitChecker | null): void {
  checker = fn;
}

/** Inspect the currently registered rate limiter. Returns `null` when unset. */
export function getEngineRateLimiter(): EngineRateLimitChecker | null {
  return checker;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetEngineRateLimiterForTests(): void {
  checker = null;
}
