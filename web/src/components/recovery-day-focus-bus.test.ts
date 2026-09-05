import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acknowledgeRecoveryFocusDay,
  consumeRecoveryFocusDay,
  RECOVERY_DAY_FOCUS_EVENT,
  requestRecoveryDayFocus,
} from './recovery-day-focus-bus'

afterEach(() => {
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('recovery day focus bus', () => {
  it('writes a valid day to the route and consumes it once', () => {
    requestRecoveryDayFocus('2026-07-06')
    expect(window.location.hash).toBe('#/runs/day/2026-07-06')
    expect(consumeRecoveryFocusDay()).toBe('2026-07-06')
    expect(window.location.hash).toBe('#/runs')
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

  it('acknowledges only the handoff adopted by the mounted queue', () => {
    requestRecoveryDayFocus('2026-07-06')
    acknowledgeRecoveryFocusDay('2026-07-05')
    expect(consumeRecoveryFocusDay()).toBe('2026-07-06')

    requestRecoveryDayFocus('2026-07-07')
    acknowledgeRecoveryFocusDay('2026-07-07')
    expect(consumeRecoveryFocusDay()).toBeNull()
  })

  it('ignores malformed day strings', () => {
    requestRecoveryDayFocus('not-a-day')
    expect(consumeRecoveryFocusDay()).toBeNull()
  })
})
