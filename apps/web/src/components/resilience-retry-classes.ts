/**
 * Canonical "retry only on" classes for the resilience fieldset — the human
 * authoring surface for the engine's selective-retry policy (`retry.retryOn`).
 *
 * Until now nobody authored `retryOn`: neither the visual editor (which
 * produced `maxAttempts` but not which errors to retry) nor the AI patch
 * surface. So `maxAttempts: 3` on an http node retried EVERY failure three
 * times — including a 400/401/404 that will never succeed, burning three
 * attempts on a guaranteed loss. Selecting classes here narrows retries to
 * transient failures; a client error then fails fast.
 *
 * Each key is a pattern string the engine's `classifyError`/`shouldRetry`
 * already emit and match (`packages/engine/src/core/retry-policy.ts`):
 * - `5xx`     — server-error status family (transient)
 * - `429`     — rate limited (transient)
 * - `timeout` — synthetic timeout label (incl. the executor's own)
 * - `network` — synthetic network label (ECONNRESET / ENOTFOUND / …)
 *
 * Leaving every class off omits `retryOn` entirely, which the engine reads as
 * "retry everything not explicitly ignored" — the unchanged default.
 *
 * Used by: `ResilienceFieldset.tsx`.
 */

/** One selectable retry class. `key` is the engine pattern string, verbatim. */
export type RetryClass = { key: string; labelKey: string; helperKey: string }

/**
 * The closed set the editor exposes. Deliberately NOT the full classifier
 * vocabulary (specific codes, error names) — those stay authorable through the
 * Advanced-JSON escape hatch. These four ARE "retry transient failures".
 */
export const RETRY_CLASSES: readonly RetryClass[] = [
  { key: '5xx', labelKey: 'rightPanel.resilience.retryOn.serverError', helperKey: 'rightPanel.resilience.retryOn.serverErrorHelper' },
  { key: '429', labelKey: 'rightPanel.resilience.retryOn.rateLimited', helperKey: 'rightPanel.resilience.retryOn.rateLimitedHelper' },
  { key: 'timeout', labelKey: 'rightPanel.resilience.retryOn.timeout', helperKey: 'rightPanel.resilience.retryOn.timeoutHelper' },
  { key: 'network', labelKey: 'rightPanel.resilience.retryOn.network', helperKey: 'rightPanel.resilience.retryOn.networkHelper' },
]

const RETRY_CLASS_KEYS: ReadonlySet<string> = new Set(RETRY_CLASSES.map((c) => c.key))

/** Read the currently-selected class keys from a raw `retry.retryOn` value. */
export function readRetryOnClasses(retryOn: unknown): Set<string> {
  if (!Array.isArray(retryOn)) return new Set()
  return new Set(retryOn.filter((entry): entry is string => typeof entry === 'string' && RETRY_CLASS_KEYS.has(entry)))
}

/**
 * Toggle one class and return the next `retryOn` array, or `undefined` when
 * the result is empty so the caller omits the key (restoring the retry-all
 * default rather than persisting an empty array that reads as "retry nothing"
 * to a human even though the engine treats `[]` as retry-all).
 *
 * PRESERVES any patterns the array already held that aren't in the editor's
 * closed set (a hand-authored `ECONNRESET` or `4xx` survives a toggle) — the
 * Advanced-JSON author's intent is not silently discarded.
 */
export function toggleRetryClass(retryOn: unknown, key: string, on: boolean): string[] | undefined {
  if (!RETRY_CLASS_KEYS.has(key)) return normalizeRetryOn(retryOn)
  const existing = Array.isArray(retryOn) ? retryOn.filter((e): e is string => typeof e === 'string') : []
  const withoutKey = existing.filter((e) => e !== key)
  const next = on ? [...withoutKey, key] : withoutKey
  return next.length > 0 ? dedupe(next) : undefined
}

function normalizeRetryOn(retryOn: unknown): string[] | undefined {
  if (!Array.isArray(retryOn)) return undefined
  const strings = dedupe(retryOn.filter((e): e is string => typeof e === 'string'))
  return strings.length > 0 ? strings : undefined
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
