import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FLOWS_SORT, nextFlowsSort, readFlowsFilters, writeFlowsFilters } from './flows-filters'

const KEY = 'janusly:flowsFilters'
const RECENT = { key: 'lastRun', direction: 'desc' } as const

afterEach(() => {
  window.localStorage.clear()
})

describe('flows-filters persistence', () => {
  it('round-trips a written view (multi-tag set)', () => {
    const sort = { key: 'health', direction: 'desc' } as const
    writeFlowsFilters({ tags: ['billing', 'urgent'], folder: 'Ops', query: 'foo', sort, collapsedFolders: ['Billing'] })
    expect(readFlowsFilters()).toEqual({ tags: ['billing', 'urgent'], folder: 'Ops', query: 'foo', sort, collapsedFolders: ['Billing'] })
  })

  it('returns null when no entry exists', () => {
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    window.localStorage.setItem(KEY, '{not json')
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on a wrong-shaped object (missing sort)', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tags: ['x'], query: 'y' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on an invalid sort value', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tags: ['x'], query: 'y', sort: 'bogus' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('returns null on a non-string query', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tags: ['x'], query: null, sort: 'recent' }))
    expect(readFlowsFilters()).toBeNull()
  })

  it('migrates a legacy scalar tag into a one-element tags array', () => {
    // A value written before the multi-tag filter carries the scalar `tag`; a
    // non-empty one becomes `[tag]`, defaulting folder to '' and collapsedFolders
    // to [] (both also pre-date this value).
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 'billing', query: 'q', sort: 'recent' }))
    expect(readFlowsFilters()).toEqual({ tags: ['billing'], folder: '', query: 'q', sort: RECENT, collapsedFolders: [] })
  })

  it('migrates a legacy empty scalar tag to an empty set', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: '', query: '', sort: 'recent', collapsedFolders: ['A'] }))
    expect(readFlowsFilters()).toEqual({ tags: [], folder: '', query: '', sort: RECENT, collapsedFolders: ['A'] })
  })

  it('prefers a present tags array over a legacy scalar tag', () => {
    // Forward-compat: once `tags` is written, a stale scalar `tag` alongside it
    // is ignored (the array wins).
    window.localStorage.setItem(KEY, JSON.stringify({ tags: ['a', 'b'], tag: 'legacy', query: '', sort: 'recent' }))
    expect(readFlowsFilters()?.tags).toEqual(['a', 'b'])
  })

  it('coerces a non-array tags value to [] (lenient — not a null-trigger)', () => {
    // A corrupt `tags` degrades to the empty set rather than discarding the whole
    // (valid query + sort) view; with no legacy scalar to fall back to, it's [].
    window.localStorage.setItem(KEY, JSON.stringify({ tags: 'nope', query: 'q', sort: 'recent' }))
    expect(readFlowsFilters()).toEqual({ tags: [], folder: '', query: 'q', sort: RECENT, collapsedFolders: [] })
  })

  it('coerces a non-string folder to \'\'', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tags: [], folder: 7, query: '', sort: 'recent', collapsedFolders: [] }))
    expect(readFlowsFilters()?.folder).toBe('')
  })

  it('coerces a non-array or non-string collapsedFolders to []', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tags: [], query: '', sort: 'recent', collapsedFolders: 'nope' }))
    expect(readFlowsFilters()?.collapsedFolders).toEqual([])
    window.localStorage.setItem(KEY, JSON.stringify({ tags: [], query: '', sort: 'recent', collapsedFolders: ['ok', 3] }))
    expect(readFlowsFilters()?.collapsedFolders).toEqual([])
  })

  it('stores only the closed shape (strips extra keys)', () => {
    const dirty = { tags: ['a'], folder: 'F', query: 'b', sort: RECENT, collapsedFolders: ['A'], extra: 'nope' } as Parameters<typeof writeFlowsFilters>[0]
    writeFlowsFilters(dirty)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ tags: ['a'], folder: 'F', query: 'b', sort: 'lastRun', sortDirection: 'desc', collapsedFolders: ['A'] })
  })

  it.each([
    ['recent', { key: 'lastRun', direction: 'desc' }],
    ['name', { key: 'name', direction: 'asc' }],
    ['failed', { key: 'status', direction: 'asc' }],
  ])('maps the old %s switch position onto its column', (sort, expected) => {
    window.localStorage.setItem(KEY, JSON.stringify({ query: '', sort }))
    expect(readFlowsFilters()?.sort).toEqual(expected)
  })

  it('falls back to the column first direction when the stored direction is invalid', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ query: '', sort: 'openFailures', sortDirection: 'sideways' }))
    expect(readFlowsFilters()?.sort).toEqual({ key: 'openFailures', direction: 'desc' })
  })
})

describe('nextFlowsSort', () => {
  it('starts a new column at its first direction and flips the active one', () => {
    const first = nextFlowsSort(DEFAULT_FLOWS_SORT, 'health')
    expect(first).toEqual({ key: 'health', direction: 'asc' })
    expect(nextFlowsSort(first, 'health')).toEqual({ key: 'health', direction: 'desc' })
    expect(nextFlowsSort(first, 'openFailures')).toEqual({ key: 'openFailures', direction: 'desc' })
  })
})
