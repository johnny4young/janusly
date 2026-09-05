/**
 * Navigation that must land on the Recovery Queue, spelled as the route
 * `#/runs/dlq[/<deadLetterId>]`. The queue is lazy-mounted under Runs, so a
 * request written before it mounts is read from the route on mount and
 * cleared once (consume-once); a live event covers the already-mounted case.
 * An optional dead-letter id targets a specific row; otherwise the queue
 * heading is the focus destination.
 *
 * `consumeDeadLetterDeepLink` is the entry point from OUTSIDE the app: an
 * alert notification links to `?deadLetterId=<id>`, and that lands here as
 * the same focus request an in-app CTA produces.
 */
import { readRoute, writeRoute } from '../lib/route'

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

function pendingRequest(): RecoveryQueueFocusRequest | null {
  const route = readRoute()
  if (!route || route.tab !== 'runs') return null
  if (route.deadLetterId) return { deadLetterId: route.deadLetterId }
  return route.queueFocus ? {} : null
}

/** Read and clear the pending queue focus request. */
export function consumeRecoveryQueueFocus(): RecoveryQueueFocusRequest | null {
  const request = pendingRequest()
  if (request) writeRoute({ tab: 'runs' }, 'replace')
  return request
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
  writeRoute(request.deadLetterId ? { tab: 'runs', deadLetterId: request.deadLetterId } : { tab: 'runs', queueFocus: true })
  window.dispatchEvent(new CustomEvent(RECOVERY_QUEUE_FOCUS_EVENT, { detail: request }))
}

/** Query param an alert notification uses to point at one failure. */
const DEEP_LINK_PARAM = 'deadLetterId'

/**
 * Read (and clear) a `?deadLetterId=` deep link from the URL bar, or the
 * failure named by a `#/runs/dlq/<id>` route someone shared.
 *
 * An alert is the start of the MTTR clock, so its link has to land the
 * operator on the exact failure rather than a queue to hunt through. The id
 * goes through the same `normalizeRequest` validation as an in-app request —
 * it arrives from outside the app and is untrusted.
 *
 * The query form is consume-once, mirroring `consumeSsoSessionFragment`: the
 * param is stripped from the URL and the history entry so a reload or a
 * back-navigation doesn't re-trigger the jump and yank the operator away from
 * what they moved on to. The route form is the shareable spelling and stays.
 */
export function consumeDeadLetterDeepLink(): RecoveryQueueFocusRequest | null {
  if (typeof window === 'undefined' || !window.location) return null
  try {
    const params = new URLSearchParams(window.location.search || '')
    const raw = params.get(DEEP_LINK_PARAM)
    if (raw === null) {
      const route = readRoute()
      return route?.tab === 'runs' && route.deadLetterId ? { deadLetterId: route.deadLetterId } : null
    }
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
