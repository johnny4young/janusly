import { describe, expect, it } from 'vitest'

import { expiryStatus, EXPIRY_SOON_DAYS } from './credential-expiry'

const DAY = 86_400_000
const NOW = new Date('2026-07-06T00:00:00.000Z').getTime()

describe('expiryStatus', () => {
  it('returns none for null / undefined / unparseable', () => {
    expect(expiryStatus(null, NOW)).toEqual({ kind: 'none' })
    expect(expiryStatus(undefined, NOW)).toEqual({ kind: 'none' })
    expect(expiryStatus('not-a-date', NOW)).toEqual({ kind: 'none' })
  })

  it('flags an already-past expiry as expired (days <= 0)', () => {
    const past = new Date(NOW - 2 * DAY).toISOString()
    const status = expiryStatus(past, NOW)
    expect(status.kind).toBe('expired')
    if (status.kind === 'expired') expect(status.days).toBeLessThanOrEqual(0)
  })

  it('flags expiry exactly at now as expired', () => {
    expect(expiryStatus(new Date(NOW).toISOString(), NOW)).toEqual({ kind: 'expired', days: 0 })
  })

  it('flags expiry within the soon window as soon', () => {
    const soon = new Date(NOW + 3 * DAY).toISOString()
    expect(expiryStatus(soon, NOW)).toEqual({ kind: 'soon', days: 3 })
  })

  it('treats the soon-window boundary (14 days) as soon, one day past as ok', () => {
    expect(expiryStatus(new Date(NOW + EXPIRY_SOON_DAYS * DAY).toISOString(), NOW).kind).toBe('soon')
    expect(expiryStatus(new Date(NOW + (EXPIRY_SOON_DAYS + 1) * DAY).toISOString(), NOW).kind).toBe('ok')
  })

  it('flags a far-out expiry as ok with whole days', () => {
    const far = new Date(NOW + 30 * DAY).toISOString()
    expect(expiryStatus(far, NOW)).toEqual({ kind: 'ok', days: 30 })
  })

  it('ceils a partial final day so 1.2 days reads as 2', () => {
    const status = expiryStatus(new Date(NOW + DAY + DAY / 5).toISOString(), NOW)
    expect(status.kind).toBe('soon')
    if (status.kind === 'soon') expect(status.days).toBe(2)
  })
})
