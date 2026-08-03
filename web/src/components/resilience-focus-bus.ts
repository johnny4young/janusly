/**
 * Cross-component handoff from a readiness finding to an Inspector resilience
 * fieldset. The pending node id survives the tab change, while the live event
 * makes an already-mounted Inspector respond immediately.
 */

const STORAGE_KEY = 'janusly:readiness:resilience-node'
export const RESILIENCE_FOCUS_EVENT = 'janusly:readiness:resilience-focus'

function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Consume a pending focus request only when it targets this node. */
export function consumeResilienceFocus(nodeId: string): boolean {
  try {
    const pending = window.sessionStorage.getItem(STORAGE_KEY)
    if (!isNodeId(pending)) {
      if (pending) window.sessionStorage.removeItem(STORAGE_KEY)
      return false
    }
    if (pending !== nodeId) return false
    window.sessionStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

/** Request that the matching Inspector fieldset receives focus. */
export function requestResilienceFocus(nodeId: string): void {
  if (!isNodeId(nodeId)) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, nodeId)
  } catch {
    // The event below still reaches an already-mounted Inspector.
  }
  window.dispatchEvent(new CustomEvent(RESILIENCE_FOCUS_EVENT, { detail: nodeId }))
}
