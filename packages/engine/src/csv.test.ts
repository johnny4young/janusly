import { describe, expect, it } from 'vitest'
import { filterCsv, parseCsv, stringifyCsv } from './csv'

describe('parseCsv', () => {
  it('parses a header + rows into objects by default', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('returns string[][] when hasHeader: false', () => {
    expect(parseCsv('1,2\n3,4', false)).toEqual([['1', '2'], ['3', '4']])
  })

  it('honors quoted fields with embedded commas', () => {
    expect(parseCsv('a,b\n"1,000",2')).toEqual([{ a: '1,000', b: '2' }])
  })

  it('honors escaped double-quotes inside a quoted field', () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([{ a: 'she said "hi"' }])
  })

  it('handles CRLF and LF line endings interchangeably', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4\r\n')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([{ a: '1', b: '2' }])
  })

  it('returns [] for an empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('', false)).toEqual([])
  })
})

describe('stringifyCsv', () => {
  it('round-trips parseCsv for plain values', () => {
    const rows = parseCsv('a,b\n1,2\n3,4') as Array<Record<string, string>>
    expect(stringifyCsv(rows, ['a', 'b'])).toBe('a,b\n1,2\n3,4')
  })

  it('quotes fields containing the delimiter', () => {
    expect(stringifyCsv([{ a: '1,000', b: '2' }], ['a', 'b'])).toBe('a,b\n"1,000",2')
  })

  it('escapes embedded double-quotes inside quoted fields', () => {
    expect(stringifyCsv([{ a: 'say "hi"' }], ['a'])).toBe('a\n"say ""hi"""')
  })

  it('emits string[][] without quoting plain values', () => {
    expect(stringifyCsv([['1', '2'], ['3', '4']])).toBe('1,2\n3,4')
  })
})

describe('filterCsv', () => {
  const rows = [
    { id: '1', status: 'open' },
    { id: '2', status: 'closed' },
    { id: '3', status: 'open' },
  ]

  it('returns rows matching every entry in `where`', () => {
    expect(filterCsv(rows, { status: 'open' })).toEqual([
      { id: '1', status: 'open' },
      { id: '3', status: 'open' },
    ])
  })

  it('returns the input unchanged when `where` is empty', () => {
    expect(filterCsv(rows, {})).toEqual(rows)
  })

  it('returns [] when no row matches', () => {
    expect(filterCsv(rows, { status: 'wat' })).toEqual([])
  })
})
