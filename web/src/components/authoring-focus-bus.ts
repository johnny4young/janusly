/** Consume-once handoff from a Problems row to the selected Inspector entity. */

const STORAGE_KEY = 'janusly:authoring:entity-focus'
export const AUTHORING_FOCUS_EVENT = 'janusly:authoring:entity-focus'

export type AuthoringFocusRequest = { kind: 'node' | 'edge'; id: string }

function normalize(value: unknown): AuthoringFocusRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, id } = value as { kind?: unknown; id?: unknown }
  if ((kind !== 'node' && kind !== 'edge') || typeof id !== 'string') return null
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 256) return null
  return { kind, id: trimmed }
}

export function consumeAuthoringFocus(): AuthoringFocusRequest | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw) window.sessionStorage.removeItem(STORAGE_KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function parseAuthoringFocusEvent(event: Event): AuthoringFocusRequest | null {
  return event instanceof CustomEvent ? normalize(event.detail) : null
}

export function requestAuthoringFocus(request: AuthoringFocusRequest): void {
  const normalized = normalize(request)
  if (!normalized) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // The live event still covers an already-mounted Inspector.
  }
  window.dispatchEvent(new CustomEvent(AUTHORING_FOCUS_EVENT, { detail: normalized }))
}
