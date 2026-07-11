import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeRecoveryQueueFocus,
  parseRecoveryQueueFocusEvent,
  RECOVERY_QUEUE_FOCUS_EVENT,
  requestRecoveryQueueFocus,
} from './recovery-queue-focus-bus'

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('recovery queue focus bus', () => {
  it('stashes a queue-level request and consumes it once', () => {
    requestRecoveryQueueFocus()
    expect(consumeRecoveryQueueFocus()).toEqual({})
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('preserves a target dead-letter id and emits a live event', () => {
    const handler = vi.fn()
    window.addEventListener(RECOVERY_QUEUE_FOCUS_EVENT, handler)
    requestRecoveryQueueFocus(' dlq-123 ')

    expect(handler).toHaveBeenCalledOnce()
    expect(consumeRecoveryQueueFocus()).toEqual({ deadLetterId: 'dlq-123' })
    window.removeEventListener(RECOVERY_QUEUE_FOCUS_EVENT, handler)
  })

  it('ignores empty or overlong target ids', () => {
    requestRecoveryQueueFocus('   ')
    requestRecoveryQueueFocus('x'.repeat(257))
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('drops corrupt stored requests', () => {
    window.sessionStorage.setItem('janusly:recovery:queue-focus', '{bad json')
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('validates live event detail independently of session storage', () => {
    expect(parseRecoveryQueueFocusEvent(new CustomEvent(RECOVERY_QUEUE_FOCUS_EVENT, {
      detail: { deadLetterId: ' target ' },
    }))).toEqual({ deadLetterId: 'target' })
    expect(parseRecoveryQueueFocusEvent(new Event(RECOVERY_QUEUE_FOCUS_EVENT))).toBeNull()
  })
})
