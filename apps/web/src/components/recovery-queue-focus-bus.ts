/**
 * Consume-once handoff for navigation that must land on the Recovery Queue.
 *
 * The queue is lazy-mounted under Runs, so callers persist a small focus
 * request in sessionStorage before switching tabs. A CustomEvent covers the
 * already-mounted case. An optional dead-letter id targets a specific row;
 * otherwise the queue heading is the focus destination.
 *
 * `consumeDeadLetterDeepLink` is the entry point from OUTSIDE the app: an
 * alert notification links to `?deadLetterId=<id>`, and that lands here as
 * the same focus request an in-app CTA produces.
 */

const STORAGE_KEY = 'janusly:recovery:queue-focus'
export const RECOVERY_QUEUE_FOCUS_EVENT = 'janusly:recovery:queue-focus'

export type RecoveryQueueFocusRequest = { deadLetterId?: string }

function normalizeRequest(value: unknown): RecoveryQueueFocusRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const deadLetterId = (value as { deadLetterId?: unknown }).deadLetterId
  if (deadLetterId === undefined) return {}
  if (typeof deadLetterId !== 'string') return null
  const trimmed = deadLetterId.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return null
  return { deadLetterId: trimmed }
}

/** Read and clear the pending queue focus request. */
export function consumeRecoveryQueueFocus(): RecoveryQueueFocusRequest | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw) window.sessionStorage.removeItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeRequest(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Read and validate the live request carried by the queue focus event. */
export function parseRecoveryQueueFocusEvent(event: Event): RecoveryQueueFocusRequest | null {
  if (!(event instanceof CustomEvent)) return null
  return normalizeRequest(event.detail)
}

/** Request queue-level focus, or target one dead-letter row when its id is known. */
export function requestRecoveryQueueFocus(deadLetterId?: string): void {
  const request = normalizeRequest(deadLetterId === undefined ? {} : { deadLetterId })
  if (!request) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(request))
  } catch {
    // Storage unavailable — the live event still covers an already-mounted queue.
  }
  window.dispatchEvent(new CustomEvent(RECOVERY_QUEUE_FOCUS_EVENT, { detail: request }))
}

/** Query param an alert notification uses to point at one failure. */
const DEEP_LINK_PARAM = 'deadLetterId'

/**
 * Read (and clear) a `?deadLetterId=` deep link from the URL bar.
 *
 * An alert is the start of the MTTR clock, so its link has to land the
 * operator on the exact failure rather than a queue to hunt through. The id
 * goes through the same `normalizeRequest` validation as an in-app request —
 * it arrives from outside the app and is untrusted.
 *
 * Consume-once, mirroring `consumeSsoSessionFragment`: the param is stripped
 * from the URL and the history entry so a reload or a back-navigation doesn't
 * re-trigger the jump and yank the operator away from what they moved on to.
 */
export function consumeDeadLetterDeepLink(): RecoveryQueueFocusRequest | null {
  if (typeof window === 'undefined' || !window.location) return null
  try {
    const params = new URLSearchParams(window.location.search || '')
    const raw = params.get(DEEP_LINK_PARAM)
    if (!raw) return null

    params.delete(DEEP_LINK_PARAM)
    const query = params.toString()
    const cleanUrl = window.location.pathname + (query ? `?${query}` : '') + (window.location.hash || '')
    try {
      window.history.replaceState(null, '', cleanUrl || '/')
    } catch {
      // Non-fatal: the jump still works, it just survives a reload.
    }
    return normalizeRequest({ deadLetterId: raw })
  } catch {
    return null
  }
}
