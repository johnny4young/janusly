/**
 * Cross-cutting numeric constants for the engine layer. Today the only
 * cross-engine number that needs a shared home is the rate-limiter
 * window — engine-side integration tools (slack, github, webhook, email,
 * pdf, mcp tool) all call into the Redis-backed limiter with the same
 * 1-minute rolling window the API uses. The window can't live in
 * `apps/api/src/constants.ts` because `packages/engine` cannot import
 * from `apps/api` (layering direction is api → engine, never the
 * reverse).
 *
 * Domain-specific engine constants stay with their consumers:
 * - `mcp-sandbox.ts` owns `SANDBOX_DEFAULT_*` (lifetime / stderr / VM).
 * - `pdf-renderer.ts` owns `MAX_TEMPLATE_BYTES`.
 * - `http-policy.ts` owns `DEFAULT_TIMEOUT_MS` (outbound HTTP timeout).
 * - `tool-registry.ts` owns the per-tool Zod schema bounds.
 *
 * Moving those would split cohesion with the code that reads them for
 * marginal centralization benefit. This module exists for the genuinely
 * cross-cutting numbers only.
 */

/** Shared 1-minute rolling window for the engine-side rate limiter. Same
 *  VALUE as `apps/api/src/constants.ts:RATE_LIMIT_WINDOW_MS` but a
 *  separate constant because of package-layering (engine cannot import
 *  from api). Both should move together if the global window ever
 *  changes — keep them in sync. */
export const RATE_LIMIT_WINDOW_MS = 60_000 as const
