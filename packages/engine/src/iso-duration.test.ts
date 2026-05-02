import { describe, expect, it } from 'vitest'
import { parseIsoDuration } from './iso-duration'

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

describe('parseIsoDuration', () => {
  it('parses days', () => {
    expect(parseIsoDuration('P3D')).toBe(3 * DAY)
  })

  it('parses combined hours + minutes', () => {
    expect(parseIsoDuration('PT2H30M')).toBe(2 * HOUR + 30 * MINUTE)
  })

  it('parses years using a 365-day approximation', () => {
    expect(parseIsoDuration('P1Y')).toBe(365 * DAY)
  })

  it('parses days + hours', () => {
    expect(parseIsoDuration('P1DT12H')).toBe(DAY + 12 * HOUR)
  })

  it('parses fractional seconds', () => {
    expect(parseIsoDuration('PT1.5S')).toBe(1500)
  })

  it('returns null for the empty P / PT forms', () => {
    expect(parseIsoDuration('P')).toBeNull()
    expect(parseIsoDuration('PT')).toBeNull()
  })

  it('returns null for malformed strings', () => {
    expect(parseIsoDuration('1D')).toBeNull()
    expect(parseIsoDuration('P1X')).toBeNull()
    expect(parseIsoDuration('-P1D')).toBeNull()
    expect(parseIsoDuration('')).toBeNull()
  })

  it('returns null for non-string inputs', () => {
    expect(parseIsoDuration(undefined as unknown as string)).toBeNull()
    expect(parseIsoDuration(123 as unknown as string)).toBeNull()
  })
})
