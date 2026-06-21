import { afterEach, describe, expect, it } from 'vitest'
import { readFlowsFilters, writeFlowsFilters } from './flows-filters'

const KEY = 'janusly:flowsFilters'

afterEach(() => {
  window.localStorage.clear()
})

describe('flows-filters persistence', () => {
  it('round-trips a written view', () => {
    writeFlowsFilters({ tag: 'billing', folder: 'Ops', query: 'foo', sort: 'name', collapsedFolders: ['Billing'] })
    expect(readFlowsFilters()).toEqual({ tag: 'billing', folder: 'Ops', query: 'foo', sort: 'name', collapsedFolders: ['Billing'] })
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

  it('restores a pre-folders value (no folder / collapsedFolders) defaulting them', () => {
    // A value written before the folder field shipped carries only
    // { tag, query, sort }; it must still restore, defaulting folder to '' and
    // collapsedFolders to [].
    window.localStorage.setItem(KEY, JSON.stringify({ tag: 'billing', query: 'q', sort: 'recent' }))
    expect(readFlowsFilters()).toEqual({ tag: 'billing', folder: '', query: 'q', sort: 'recent', collapsedFolders: [] })
  })

  it('restores a pre-folder-filter value (collapsedFolders but no folder) defaulting folder to \'\'', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: '', query: '', sort: 'recent', collapsedFolders: ['A'] }))
    expect(readFlowsFilters()).toEqual({ tag: '', folder: '', query: '', sort: 'recent', collapsedFolders: ['A'] })
  })

  it('coerces a non-string folder to \'\'', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: '', folder: 7, query: '', sort: 'recent', collapsedFolders: [] }))
    expect(readFlowsFilters()?.folder).toBe('')
  })

  it('coerces a non-array or non-string collapsedFolders to []', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tag: '', query: '', sort: 'recent', collapsedFolders: 'nope' }))
    expect(readFlowsFilters()?.collapsedFolders).toEqual([])
    window.localStorage.setItem(KEY, JSON.stringify({ tag: '', query: '', sort: 'recent', collapsedFolders: ['ok', 3] }))
    expect(readFlowsFilters()?.collapsedFolders).toEqual([])
  })

  it('stores only the closed shape (strips extra keys)', () => {
    const dirty = { tag: 'a', folder: 'F', query: 'b', sort: 'recent', collapsedFolders: ['A'], extra: 'nope' } as Parameters<typeof writeFlowsFilters>[0]
    writeFlowsFilters(dirty)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ tag: 'a', folder: 'F', query: 'b', sort: 'recent', collapsedFolders: ['A'] })
  })
})
