import { describe, expect, it } from 'vitest'
import { getMemoryPurgeCountdown, parseMemoryConsentStatus } from './memory-consent-status'

describe('parseMemoryConsentStatus', () => {
  it('accepts every valid purge state', () => {
    const base = { enabled: false, processEnabled: true, tenantEnabled: false }
    expect(parseMemoryConsentStatus({ ...base, purge: { status: 'none', scheduledFor: null } })?.purge.status).toBe('none')
    expect(parseMemoryConsentStatus({ ...base, purge: { status: 'unknown', scheduledFor: null } })?.purge.status).toBe('unknown')
    expect(parseMemoryConsentStatus({ ...base, purge: { status: 'running', scheduledFor: null } })?.purge.status).toBe('running')
    expect(parseMemoryConsentStatus({ ...base, purge: { status: 'scheduled', scheduledFor: '2026-07-21T12:00:00.000Z' } })?.purge.status).toBe('scheduled')
  })

  it('rejects malformed booleans, discriminants, and dates', () => {
    expect(parseMemoryConsentStatus(null)).toBeNull()
    expect(parseMemoryConsentStatus({ enabled: 'yes', processEnabled: true, tenantEnabled: true, purge: { status: 'none', scheduledFor: null } })).toBeNull()
    expect(parseMemoryConsentStatus({ enabled: true, processEnabled: true, tenantEnabled: true, purge: { status: 'scheduled', scheduledFor: 'tomorrow' } })).toBeNull()
    expect(parseMemoryConsentStatus({ enabled: true, processEnabled: true, tenantEnabled: true, purge: { status: 'scheduled', scheduledFor: '1' } })).toBeNull()
    expect(parseMemoryConsentStatus({ enabled: true, processEnabled: true, tenantEnabled: true, purge: { status: 'none', scheduledFor: '2026-07-21T12:00:00.000Z' } })).toBeNull()
  })
})

describe('getMemoryPurgeCountdown', () => {
  it('splits the remaining duration into bounded day, hour, and minute fields', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z')
    expect(getMemoryPurgeCountdown('2026-07-21T14:15:00.000Z', now)).toEqual({ days: 7, hours: 2, minutes: 15 })
  })

  it('rounds future partial minutes up and clamps past dates to zero', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z')
    expect(getMemoryPurgeCountdown('2026-07-14T12:00:01.000Z', now)).toEqual({ days: 0, hours: 0, minutes: 1 })
    expect(getMemoryPurgeCountdown('2026-07-14T11:00:00.000Z', now)).toEqual({ days: 0, hours: 0, minutes: 0 })
  })
})
