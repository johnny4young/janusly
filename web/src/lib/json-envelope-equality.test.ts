import { describe, expect, it } from 'vitest'
import { jsonEquivalent } from './json-envelope-equality'

describe('independent JSON envelope equality', () => {
  it('compares key-order-independent objects and ordered arrays', () => {
    expect(jsonEquivalent({ first: [1, null], second: {} }, { second: {}, first: [1, null] })).toBe(true)
    expect(jsonEquivalent({ first: [1, 2] }, { first: [2, 1] })).toBe(false)
    expect(jsonEquivalent({ first: null }, {})).toBe(false)
  })
  it('rejects shared ownership and cyclic envelopes', () => {
    const shared = { leaf: 'value' }
    expect(jsonEquivalent(shared, shared)).toBe(false)
    expect(jsonEquivalent({ field: shared }, { field: shared })).toBe(false)
    const left: Record<string, unknown> = {}
    const right: Record<string, unknown> = {}
    left.self = left
    right.self = right
    expect(jsonEquivalent(left, right)).toBe(false)
  })
})
