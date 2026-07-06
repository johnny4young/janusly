import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeRecoveryFocusDay,
  RECOVERY_DAY_FOCUS_EVENT,
  requestRecoveryDayFocus,
} from './recovery-day-focus-bus'

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('recovery day focus bus', () => {
  it('stashes a valid day and consumes it once', () => {
    requestRecoveryDayFocus('2026-07-06')
    expect(consumeRecoveryFocusDay()).toBe('2026-07-06')
    // consume-once: a second read is empty.
    expect(consumeRecoveryFocusDay()).toBeNull()
  })

  it('dispatches the focus event for an already-mounted listener', () => {
    const handler = vi.fn()
    window.addEventListener(RECOVERY_DAY_FOCUS_EVENT, handler)
    requestRecoveryDayFocus('2026-07-06')
    expect(handler).toHaveBeenCalledOnce()
    window.removeEventListener(RECOVERY_DAY_FOCUS_EVENT, handler)
  })

  it('ignores malformed day strings', () => {
    requestRecoveryDayFocus('not-a-day')
    expect(consumeRecoveryFocusDay()).toBeNull()
  })
})
