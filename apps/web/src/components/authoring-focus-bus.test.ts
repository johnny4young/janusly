import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTHORING_FOCUS_EVENT,
  consumeAuthoringFocus,
  parseAuthoringFocusEvent,
  requestAuthoringFocus,
} from './authoring-focus-bus'

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('authoring focus handoff', () => {
  it('persists a valid request once and emits the same live detail', () => {
    const listener = vi.fn()
    window.addEventListener(AUTHORING_FOCUS_EVENT, listener)
    requestAuthoringFocus({ kind: 'node', id: ' gate ' })
    const event = listener.mock.calls[0]?.[0] as Event

    expect(parseAuthoringFocusEvent(event)).toEqual({ kind: 'node', id: 'gate' })
    expect(consumeAuthoringFocus()).toEqual({ kind: 'node', id: 'gate' })
    expect(consumeAuthoringFocus()).toBeNull()
    window.removeEventListener(AUTHORING_FOCUS_EVENT, listener)
  })

  it('uses live detail when storage is blocked and rejects invalid requests', () => {
    const listener = vi.fn()
    window.addEventListener(AUTHORING_FOCUS_EVENT, listener)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('blocked') })
    requestAuthoringFocus({ kind: 'edge', id: 'path-a' })
    expect(parseAuthoringFocusEvent(listener.mock.calls[0]?.[0] as Event)).toEqual({ kind: 'edge', id: 'path-a' })
    expect(parseAuthoringFocusEvent(new CustomEvent(AUTHORING_FOCUS_EVENT, { detail: { kind: 'node', id: '' } }))).toBeNull()
    window.removeEventListener(AUTHORING_FOCUS_EVENT, listener)
  })
})
