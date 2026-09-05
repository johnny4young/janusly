import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeDeadLetterDeepLink,
  consumeRecoveryQueueFocus,
  parseRecoveryQueueFocusEvent,
  RECOVERY_QUEUE_FOCUS_EVENT,
  requestRecoveryQueueFocus,
} from './recovery-queue-focus-bus'

afterEach(() => {
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('recovery queue focus bus', () => {
  it('writes a queue-level request to the route and consumes it once', () => {
    requestRecoveryQueueFocus()
    expect(window.location.hash).toBe('#/runs/dlq')
    expect(consumeRecoveryQueueFocus()).toEqual({})
    expect(window.location.hash).toBe('#/runs')
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('preserves a target dead-letter id and emits a live event', () => {
    const handler = vi.fn()
    window.addEventListener(RECOVERY_QUEUE_FOCUS_EVENT, handler)
    requestRecoveryQueueFocus(' dlq-123 ')

    expect(handler).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('#/runs/dlq/dlq-123')
    expect(consumeRecoveryQueueFocus()).toEqual({ deadLetterId: 'dlq-123' })
    window.removeEventListener(RECOVERY_QUEUE_FOCUS_EVENT, handler)
  })

  it('ignores empty or overlong target ids', () => {
    requestRecoveryQueueFocus('   ')
    requestRecoveryQueueFocus('x'.repeat(257))
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('ignores routes that are not a queue request', () => {
    window.history.replaceState(null, '', '/#/runs/day/2026-07-06')
    expect(consumeRecoveryQueueFocus()).toBeNull()
    window.history.replaceState(null, '', '/#/recoveryCase/dlq-1')
    expect(consumeRecoveryQueueFocus()).toBeNull()
  })

  it('validates live event detail independently of the route', () => {
    expect(parseRecoveryQueueFocusEvent(new CustomEvent(RECOVERY_QUEUE_FOCUS_EVENT, {
      detail: { deadLetterId: ' target ' },
    }))).toEqual({ deadLetterId: 'target' })
    expect(parseRecoveryQueueFocusEvent(new Event(RECOVERY_QUEUE_FOCUS_EVENT))).toBeNull()
  })
})

describe('consumeDeadLetterDeepLink — the alert -> failure jump', () => {
  function setUrl(url: string) {
    window.history.replaceState(null, '', url)
  }

  it('reads the id an alert linked to and strips it from the URL', () => {
    setUrl('/?deadLetterId=dl-42')

    expect(consumeDeadLetterDeepLink()).toEqual({ deadLetterId: 'dl-42' })
    expect(window.location.search).toBe('')
  })

  it('is consume-once — a reload must not yank the operator back to the alert row', () => {
    setUrl('/?deadLetterId=dl-42')
    consumeDeadLetterDeepLink()

    expect(consumeDeadLetterDeepLink()).toBeNull()
  })

  it('keeps the rest of the query string intact', () => {
    setUrl('/?tab=runs&deadLetterId=dl-42&x=1')

    expect(consumeDeadLetterDeepLink()).toEqual({ deadLetterId: 'dl-42' })
    expect(window.location.search).toBe('?tab=runs&x=1')
  })

  it('returns null when there is no deep link', () => {
    setUrl('/?tab=runs')

    expect(consumeDeadLetterDeepLink()).toBeNull()
    expect(window.location.search).toBe('?tab=runs')
  })

  it('rejects an untrusted oversized id — the value arrives from outside the app', () => {
    setUrl(`/?deadLetterId=${'x'.repeat(300)}`)

    expect(consumeDeadLetterDeepLink()).toBeNull()
  })

  it('rejects an empty id rather than requesting a blank selection', () => {
    setUrl('/?deadLetterId=')

    expect(consumeDeadLetterDeepLink()).toBeNull()
  })

  it('decodes an encoded id', () => {
    setUrl(`/?deadLetterId=${encodeURIComponent('dl 42&x=1')}`)

    expect(consumeDeadLetterDeepLink()).toEqual({ deadLetterId: 'dl 42&x=1' })
  })

  it('reads a shared #/runs/dlq/<id> route and leaves it in place', () => {
    setUrl('/#/runs/dlq/dl-77')

    expect(consumeDeadLetterDeepLink()).toEqual({ deadLetterId: 'dl-77' })
    expect(window.location.hash).toBe('#/runs/dlq/dl-77')
  })
})
