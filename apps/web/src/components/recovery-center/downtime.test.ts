import { describe, expect, it } from 'vitest'
import { changeRuntimeLocale } from '../../i18n'

import {
  DOWNTIME_DANGER_MINUTES,
  DOWNTIME_WARN_MINUTES,
  computeLongestOpenDowntime,
  downtimeSeverity,
  formatDuration,
  formatDowntime,
} from './helpers'

const MIN = 60_000
const NOW = 1_700_000_000_000

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * MIN).toISOString()
}

describe('downtimeSeverity', () => {
  it('is ok below the warn threshold', () => {
    expect(downtimeSeverity(isoMinutesAgo(DOWNTIME_WARN_MINUTES - 1), NOW)).toBe('ok')
  })

  it('warms to warn at ≥1h', () => {
    expect(downtimeSeverity(isoMinutesAgo(DOWNTIME_WARN_MINUTES), NOW)).toBe('warn')
    expect(downtimeSeverity(isoMinutesAgo(DOWNTIME_DANGER_MINUTES - 1), NOW)).toBe('warn')
  })

  it('escalates to danger at ≥4h', () => {
    expect(downtimeSeverity(isoMinutesAgo(DOWNTIME_DANGER_MINUTES), NOW)).toBe('danger')
    expect(downtimeSeverity(isoMinutesAgo(DOWNTIME_DANGER_MINUTES + 600), NOW)).toBe('danger')
  })

  it('is ok when the clock is not ready or the timestamp is unusable', () => {
    expect(downtimeSeverity(isoMinutesAgo(300), null)).toBe('ok')
    expect(downtimeSeverity(undefined, NOW)).toBe('ok')
    expect(downtimeSeverity('not-a-date', NOW)).toBe('ok')
  })
})

describe('formatDowntime', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDowntime(45_000)).toBe('45s')
    expect(formatDowntime(12 * MIN)).toBe('12m')
    expect(formatDowntime(60 * MIN)).toBe('1h')
    expect(formatDowntime((3 * 60 + 14) * MIN)).toBe('3h 14m')
  })

  it('returns empty for bad input', () => {
    expect(formatDowntime(-1)).toBe('')
    expect(formatDowntime(Number.NaN)).toBe('')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [12 * MIN, '12m'],
    [60 * MIN, '1h'],
    [(3 * 60 + 14) * MIN, '3h 14m'],
  ])('formats %dms in the shared clock style', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
    expect(formatDowntime(ms)).toBe(expected)
  })

  it('localizes the shared age style in English and Spanish', () => {
    expect(formatDuration(2 * MIN, 'age')).toBe('2m ago')
    try {
      changeRuntimeLocale('es')
      expect(formatDuration(2 * MIN, 'age')).toBe('hace 2m')
    } finally {
      changeRuntimeLocale('en')
    }
  })
})

describe('computeLongestOpenDowntime', () => {
  it('returns the oldest valid failure and its duration', () => {
    expect(computeLongestOpenDowntime([
      { createdAt: isoMinutesAgo(30) },
      { createdAt: isoMinutesAgo(240) },
      { createdAt: isoMinutesAgo(60) },
    ], NOW)).toEqual({ createdAt: isoMinutesAgo(240), durationMs: 240 * MIN })
  })

  it('ignores missing, invalid, and future timestamps', () => {
    expect(computeLongestOpenDowntime([
      {},
      { createdAt: 'not-a-date' },
      { createdAt: new Date(NOW + MIN).toISOString() },
    ], NOW)).toBeNull()
    expect(computeLongestOpenDowntime([{ createdAt: isoMinutesAgo(10) }], null)).toBeNull()
  })
})
