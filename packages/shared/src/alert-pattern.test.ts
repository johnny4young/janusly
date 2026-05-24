import { describe, expect, it } from 'vitest'

import { matchGlob } from './alert-pattern'

describe('matchGlob', () => {
  it('matches a literal pattern exactly', () => {
    expect(matchGlob('Missing secret: GITHUB_TOKEN', 'Missing secret: GITHUB_TOKEN')).toBe(true)
    expect(matchGlob('Missing secret: GITHUB_TOKEN', 'Missing secret: SLACK_TOKEN')).toBe(false)
  })

  it('matches with trailing *', () => {
    expect(matchGlob('Missing secret: *', 'Missing secret: GITHUB_TOKEN')).toBe(true)
    expect(matchGlob('Missing secret: *', 'Missing secret: ')).toBe(true)
    expect(matchGlob('Missing secret: *', 'Not even a secret error')).toBe(false)
  })

  it('matches with leading *', () => {
    expect(matchGlob('*HTTP 401*', 'POST /webhook → HTTP 401 unauthorized')).toBe(true)
    expect(matchGlob('*HTTP 401*', 'HTTP 500 internal server error')).toBe(false)
  })

  it('matches middle * across multiple chars', () => {
    expect(matchGlob('HTTP * on *', 'HTTP 500 on http node')).toBe(true)
    expect(matchGlob('HTTP * on *', 'HTTP on http node')).toBe(false)
  })

  it('? matches exactly one character', () => {
    expect(matchGlob('HTTP ???', 'HTTP 401')).toBe(true)
    expect(matchGlob('HTTP ???', 'HTTP 4')).toBe(false)
    expect(matchGlob('HTTP ???', 'HTTP 4011')).toBe(false)
  })

  it('* matches empty', () => {
    expect(matchGlob('abc*xyz', 'abcxyz')).toBe(true)
  })

  it('handles consecutive stars without exponential cost', () => {
    const big = 'a'.repeat(200)
    expect(matchGlob('***a***', big)).toBe(true)
    expect(matchGlob('***b***', big)).toBe(false)
  })

  it('rejects when literal prefix does not match', () => {
    expect(matchGlob('error: *', 'warning: something')).toBe(false)
  })

  it('treats regex metachars as literals', () => {
    expect(matchGlob('a.b', 'a.b')).toBe(true)
    expect(matchGlob('a.b', 'axb')).toBe(false)
    expect(matchGlob('(group)', '(group)')).toBe(true)
  })
})
