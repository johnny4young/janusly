import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  consumeRecoveryAllClear,
  parseRecoveryAllClearEvent,
  RECOVERY_ALL_CLEAR_EVENT,
  RECOVERY_ALL_CLEAR_WINDOW_MS,
  requestRecoveryAllClear,
} from './recovery-all-clear-bus'

describe('recovery all-clear bus', () => {
  beforeEach(() => {
    localStorage.setItem('janusly:activeOrg', 'org-a')
    consumeRecoveryAllClear()
  })

  it('hands a valid request across one remount and consumes it once', () => {
    requestRecoveryAllClear({ downtimeMs: 42_000 })

    expect(consumeRecoveryAllClear()).toEqual({ downtimeMs: 42_000 })
    expect(consumeRecoveryAllClear()).toBeNull()
  })

  it('publishes a validated live event without browser persistence', () => {
    let eventRequest: unknown = null
    const listener = (event: Event) => { eventRequest = parseRecoveryAllClearEvent(event) }
    window.addEventListener(RECOVERY_ALL_CLEAR_EVENT, listener)

    requestRecoveryAllClear()

    window.removeEventListener(RECOVERY_ALL_CLEAR_EVENT, listener)
    expect(eventRequest).toEqual({})
    expect(window.sessionStorage.getItem('janusly:recovery:all-clear')).toBeNull()
  })

  it('rejects malformed or negative durations', () => {
    requestRecoveryAllClear({ downtimeMs: Number.NaN })
    requestRecoveryAllClear({ downtimeMs: -1 })

    expect(consumeRecoveryAllClear()).toBeNull()
    expect(parseRecoveryAllClearEvent(new CustomEvent(RECOVERY_ALL_CLEAR_EVENT, {
      detail: { downtimeMs: '42' },
    }))).toBeNull()
  })

  it('expires an unconsumed handoff instead of celebrating stale recovery', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
    try {
      requestRecoveryAllClear({ downtimeMs: 1_000 })
      vi.advanceTimersByTime(RECOVERY_ALL_CLEAR_WINDOW_MS)

      expect(consumeRecoveryAllClear()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a handoff instead of leaking it across an organization switch', () => {
    requestRecoveryAllClear({ downtimeMs: 1_000 })
    localStorage.setItem('janusly:activeOrg', 'org-b')

    expect(consumeRecoveryAllClear()).toBeNull()
    localStorage.setItem('janusly:activeOrg', 'org-a')
    expect(consumeRecoveryAllClear()).toBeNull()
  })

  it('rejects a live event published for a different organization', () => {
    const event = new CustomEvent(RECOVERY_ALL_CLEAR_EVENT, {
      detail: { orgId: 'org-b', downtimeMs: 1_000 },
    })

    expect(parseRecoveryAllClearEvent(event)).toBeNull()
  })
})
