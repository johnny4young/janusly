/**
 * Browser API request lifecycle for identity transitions.
 *
 * Used by `api.ts` to bind every authenticated request to the current browser
 * identity generation, and by `auth.ts` to cancel that generation before
 * signing out. This prevents requests started by a departing workspace from
 * reaching the API after its token or cookie has been revoked.
 */

let generation = 0
let controller = new AbortController()
let suspended = false

export type ApiRequestLifecycle = {
  generation: number
  signal: AbortSignal
}

/** Capture the current identity generation and combine it with a caller signal. */
export function currentApiRequestLifecycle(callerSignal?: AbortSignal | null): ApiRequestLifecycle {
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal
  return { generation, signal }
}

/** Cancel every request owned by the departing identity and start a fresh generation. */
export function rotateApiRequestLifecycle(): void {
  controller.abort(new DOMException('Identity changed', 'AbortError'))
  controller = new AbortController()
  generation += 1
}

/** Keep the request channel closed while provider credentials are being revoked. */
export function suspendApiRequestLifecycle(): void {
  controller.abort(new DOMException('Identity signing out', 'AbortError'))
  suspended = true
  generation += 1
}

/** Open a new request generation when an interactive sign-in starts. */
export function resumeApiRequestLifecycle(): void {
  if (!suspended) return
  controller = new AbortController()
  suspended = false
  generation += 1
}

/** Reset module state between unit-test cases. */
export function resetApiRequestLifecycleForTests(): void {
  controller.abort(new DOMException('Test reset', 'AbortError'))
  controller = new AbortController()
  generation = 0
  suspended = false
}
