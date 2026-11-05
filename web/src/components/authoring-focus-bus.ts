/** Consume-once handoff from a Problems row to the selected Inspector entity. */

import { useEffect, useRef, type RefObject } from 'react'

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

export type AuthoringScope = 'step' | 'workflow' | 'problems'
export type AuthoringWorkflowTarget = 'outputs' | 'versions'

const AUTHORING_SCOPE_EVENT = 'janusly:authoring:scope'
let pendingScope: AuthoringScope | null = null
let pendingTarget: AuthoringWorkflowTarget | null = null

/** A jump can precede the mount of the lazy panel or its target, so both are held until read. */
export function requestAuthoringScope(scope: AuthoringScope, target: AuthoringWorkflowTarget | null = null): void {
  pendingScope = scope
  pendingTarget = target
  window.dispatchEvent(new Event(AUTHORING_SCOPE_EVENT))
}

function useAuthoringJump(read: () => void): void {
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    const apply = () => latest.current()
    apply()
    window.addEventListener(AUTHORING_SCOPE_EVENT, apply)
    return () => window.removeEventListener(AUTHORING_SCOPE_EVENT, apply)
  }, [])
}

export function useAuthoringScopeRequest(onScope: (scope: AuthoringScope) => void): void {
  useAuthoringJump(() => {
    const scope = pendingScope
    pendingScope = null
    if (scope) onScope(scope)
  })
}

/** Focus (and so scroll to) the returned element when a jump names this target. */
export function useAuthoringTargetFocus<T extends HTMLElement>(
  target: AuthoringWorkflowTarget,
  onTarget?: () => void,
): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useAuthoringJump(() => {
    if (pendingTarget !== target) return
    pendingTarget = null
    onTarget?.()
    ref.current?.focus({ preventScroll: true })
    ref.current?.scrollIntoView?.({ block: 'start' })
  })
  return ref
}
