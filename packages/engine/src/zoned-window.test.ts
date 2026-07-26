/**
 * Shared timezone/window matching plus the generic `time.window` tool.
 *
 * The PagerDuty off-hours evaluator is covered in `integration-tools.test.ts`;
 * what matters here is that both callers share one zone implementation while
 * keeping OPPOSITE postures toward malformed configuration.
 */

import { describe, expect, it } from 'vitest'

import { executeTool } from './tool-registry'
import { isWithinPagerDutyWorkingHours } from './integration-tools'
import { parseLocalMinute, windowContains, zonedClock } from './zoned-window'

// 2026-07-15 is a Wednesday. 14:30Z is 09:30 in Bogota (UTC-5).
const WEDNESDAY_1430Z = new Date('2026-07-15T14:30:00Z')
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('parseLocalMinute', () => {
  it('accepts 24h HH:MM and rejects anything else', () => {
    expect(parseLocalMinute('00:00')).toBe(0)
    expect(parseLocalMinute('09:30')).toBe(570)
    expect(parseLocalMinute('23:59')).toBe(1439)
    expect(parseLocalMinute(' 17:00 ')).toBe(1020)
    expect(parseLocalMinute('24:00')).toBeNull()
    expect(parseLocalMinute('9:30')).toBeNull()
    expect(parseLocalMinute('09:60')).toBeNull()
    expect(parseLocalMinute('noon')).toBeNull()
  })
})

describe('zonedClock', () => {
  it('resolves an instant to the target zone wall clock', () => {
    expect(zonedClock(WEDNESDAY_1430Z, 'UTC')).toEqual({ day: 3, minute: 14 * 60 + 30 })
    expect(zonedClock(WEDNESDAY_1430Z, 'America/Bogota')).toEqual({ day: 3, minute: 9 * 60 + 30 })
  })

  it('rolls the weekday backwards when the zone is behind midnight', () => {
    // 03:30Z Wednesday is still Tuesday 22:30 in Bogota.
    expect(zonedClock(new Date('2026-07-15T03:30:00Z'), 'America/Bogota'))
      .toEqual({ day: 2, minute: 22 * 60 + 30 })
  })

  it('returns null for an unknown zone instead of throwing', () => {
    expect(zonedClock(WEDNESDAY_1430Z, 'Mars/Olympus_Mons')).toBeNull()
  })
})

describe('windowContains', () => {
  const clockAt = (day: number, hour: number, minute = 0) => ({ day, minute: hour * 60 + minute })

  it('treats start as inclusive and end as exclusive', () => {
    expect(windowContains(clockAt(3, 9), WEEKDAYS, 540, 1020)).toBe(true)
    expect(windowContains(clockAt(3, 17), WEEKDAYS, 540, 1020)).toBe(false)
    expect(windowContains(clockAt(3, 8, 59), WEEKDAYS, 540, 1020)).toBe(false)
  })

  it('excludes days outside the list', () => {
    expect(windowContains(clockAt(0, 12), WEEKDAYS, 540, 1020)).toBe(false)
  })

  it('matches the tail of a midnight-crossing window against the previous day', () => {
    // Night shift: Fri 22:00 -> Sat 06:00, declared on day 5 only.
    expect(windowContains(clockAt(5, 23), [5], 1320, 360)).toBe(true)
    expect(windowContains(clockAt(6, 2), [5], 1320, 360)).toBe(true)
    expect(windowContains(clockAt(6, 7), [5], 1320, 360)).toBe(false)
    expect(windowContains(clockAt(5, 21), [5], 1320, 360)).toBe(false)
  })
})

describe('time.window tool', () => {
  it('reports a match inside business hours with the local clock', async () => {
    const result = await executeTool('time.window', {
      timeZone: 'America/Bogota',
      windows: [{ days: WEEKDAYS, start: '09:00', end: '17:00' }],
      at: WEDNESDAY_1430Z.toISOString(),
    }, {}) as Record<string, unknown>

    expect(result.inWindow).toBe(true)
    expect(result.localDay).toBe(3)
    expect(result.localTime).toBe('09:30')
    expect(result.matchedWindow).toEqual({ days: WEEKDAYS, start: '09:00', end: '17:00' })
  })

  it('reports no match outside business hours', async () => {
    const result = await executeTool('time.window', {
      timeZone: 'America/Bogota',
      // 14:30Z is 09:30 Bogota, before this window opens.
      windows: [{ days: WEEKDAYS, start: '18:00', end: '23:00' }],
      at: WEDNESDAY_1430Z.toISOString(),
    }, {}) as Record<string, unknown>

    expect(result.inWindow).toBe(false)
    expect(result.matchedWindow).toBeNull()
  })

  it('evaluates the same instant differently per zone', async () => {
    const windows = [{ days: WEEKDAYS, start: '09:00', end: '17:00' }]
    const bogota = await executeTool('time.window', {
      timeZone: 'America/Bogota', windows, at: WEDNESDAY_1430Z.toISOString(),
    }, {}) as Record<string, unknown>
    const tokyo = await executeTool('time.window', {
      timeZone: 'Asia/Tokyo', windows, at: WEDNESDAY_1430Z.toISOString(),
    }, {}) as Record<string, unknown>

    expect(bogota.inWindow).toBe(true)
    // 14:30Z is 23:30 in Tokyo — same instant, outside the same window.
    expect(tokyo.inWindow).toBe(false)
  })

  it('matches the first of several windows', async () => {
    const result = await executeTool('time.window', {
      timeZone: 'UTC',
      windows: [
        { days: WEEKDAYS, start: '06:00', end: '09:00' },
        { days: WEEKDAYS, start: '14:00', end: '18:00' },
      ],
      at: WEDNESDAY_1430Z.toISOString(),
    }, {}) as Record<string, unknown>

    expect(result.inWindow).toBe(true)
    expect(result.matchedWindow).toMatchObject({ start: '14:00' })
  })

  it('defaults to now when `at` is omitted', async () => {
    const before = Date.now()
    const result = await executeTool('time.window', {
      timeZone: 'UTC',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }],
    }, {}) as Record<string, unknown>

    expect(Date.parse(String(result.at))).toBeGreaterThanOrEqual(before)
  })

  it('rejects malformed configuration instead of answering false', async () => {
    // A decision primitive must not let bad config look like "outside window".
    await expect(executeTool('time.window', {
      timeZone: 'Mars/Olympus_Mons',
      windows: [{ days: WEEKDAYS, start: '09:00', end: '17:00' }],
    }, {})).rejects.toThrow('Invalid IANA time zone')

    await expect(executeTool('time.window', {
      timeZone: 'UTC',
      windows: [{ days: WEEKDAYS, start: '9:00', end: '17:00' }],
    }, {})).rejects.toThrow('Invalid window time')

    await expect(executeTool('time.window', {
      timeZone: 'UTC',
      windows: [{ days: WEEKDAYS, start: '09:00', end: '09:00' }],
    }, {})).rejects.toThrow('Ambiguous window')
  })

  it('rejects out-of-range weekdays at the schema boundary', async () => {
    await expect(executeTool('time.window', {
      timeZone: 'UTC',
      windows: [{ days: [7], start: '09:00', end: '17:00' }],
    }, {})).rejects.toThrow()
  })

  it('keeps the opposite failure posture from the PagerDuty evaluator', () => {
    // Same malformed zone: the tool throws (above) while the policy evaluator
    // absorbs it as "inside working hours" so it can never authorize an action.
    expect(isWithinPagerDutyWorkingHours(
      WEDNESDAY_1430Z,
      'Mars/Olympus_Mons',
      [{ days: WEEKDAYS, start: '09:00', end: '17:00' }],
    )).toBe(true)
  })
})
