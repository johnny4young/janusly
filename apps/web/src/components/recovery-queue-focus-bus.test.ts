import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeDeadLetterDeepLink,
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
})
