import { describe, expect, it } from 'vitest'
import { daysUntilPurge } from './trash-expiry'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 5, 27, 12, 0, 0) // fixed "now" so the math is deterministic

describe('daysUntilPurge', () => {
  it('returns the days remaining for a row deleted within the window', () => {
    const deletedAt = new Date(NOW - 5 * DAY).toISOString()
    expect(daysUntilPurge(deletedAt, 30, NOW)).toBe(25) // 30 - 5
  })

  it('returns a non-positive value once the window has elapsed', () => {
    const deletedAt = new Date(NOW - 40 * DAY).toISOString()
    expect(daysUntilPurge(deletedAt, 30, NOW)).toBe(-10) // 30 - 40
  })

  it('returns 0 at the exact boundary (deleted exactly retentionDays ago)', () => {
    const deletedAt = new Date(NOW - 30 * DAY).toISOString()
    expect(daysUntilPurge(deletedAt, 30, NOW)).toBe(0)
  })

  it('ceils a partial final day up (a few hours left still reads as 1 day)', () => {
    // Deleted 29 days + 20 hours ago, window 30 → ~4 hours left → ceil → 1.
    const deletedAt = new Date(NOW - (29 * DAY + 20 * 3_600_000)).toISOString()
    expect(daysUntilPurge(deletedAt, 30, NOW)).toBe(1)
  })

  it('reflects a custom (non-default) retention window', () => {
    const deletedAt = new Date(NOW - 2 * DAY).toISOString()
    expect(daysUntilPurge(deletedAt, 7, NOW)).toBe(5) // 7 - 2
  })
})
