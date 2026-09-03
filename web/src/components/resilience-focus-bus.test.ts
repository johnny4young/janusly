import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeResilienceFocus,
  requestResilienceFocus,
  RESILIENCE_FOCUS_EVENT,
} from './resilience-focus-bus'

afterEach(() => {
  window.sessionStorage.clear()
})

describe('resilience focus bus', () => {
  it('hands a requested node to its matching Inspector fieldset exactly once', () => {
    requestResilienceFocus('fetch-customer')

    expect(consumeResilienceFocus('other-node')).toBe(false)
    expect(consumeResilienceFocus('fetch-customer')).toBe(true)
    expect(consumeResilienceFocus('fetch-customer')).toBe(false)
  })

  it('emits a live focus event for an already-mounted Inspector', () => {
    const listener = vi.fn()
    window.addEventListener(RESILIENCE_FOCUS_EVENT, listener)

    requestResilienceFocus('fetch-customer')

    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(RESILIENCE_FOCUS_EVENT, listener)
  })

  it('ignores an empty node id', () => {
    requestResilienceFocus('')

    expect(consumeResilienceFocus('fetch-customer')).toBe(false)
  })
})
