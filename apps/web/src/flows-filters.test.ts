import { afterEach, describe, expect, it } from 'vitest'
import { readFlowsFilters, writeFlowsFilters } from './flows-filters'

const KEY = 'janusly:flowsFilters'

afterEach(() => {
  window.localStorage.clear()
})

describe('flows-filters persistence', () => {
  it('round-trips a written triple', () => {
    writeFlowsFilters({ tag: 'billing', query: 'foo', sort: 'name' })
    expect(readFlowsFilters()).toEqual({ tag: 'billing', query: 'foo', sort: 'name' })
  })

  it('returns null when no entry exists', () => {
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    window.localStorage.setItem(KEY, '{not json')
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on a wrong-shaped object (missing field)', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 'x', query: 'y' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on an invalid sort value', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 'x', query: 'y', sort: 'bogus' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on a non-string tag or query', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 1, query: 'y', sort: 'recent' }))
    expect(readFlowsFilters()).toBeNull()
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 'x', query: null, sort: 'recent' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('stores only the tag/query/sort triple (strips extra keys)', () => {
    const dirty = { tag: 'a', query: 'b', sort: 'recent', extra: 'nope' } as Parameters<typeof writeFlowsFilters>[0]
    writeFlowsFilters(dirty)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ tag: 'a', query: 'b', sort: 'recent' })
  })
})
