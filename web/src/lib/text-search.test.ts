import { describe, expect, it } from 'vitest'
import {
  activeTextSearch,
  classifyTextSearch,
  TEXT_SEARCH_MAX_CHARACTERS,
} from './text-search'

describe('bounded text search', () => {
  it.each([
    ['   ', 'empty'],
    ['ab', 'too-short'],
    ['a b c', 'too-short'],
    ['%_\\', 'too-short'],
    ['e\u0301xy', 'too-short'],
    ['abc%_\\', 'valid'],
    ['café', 'valid'],
    ['界界界', 'valid'],
    ['abc\u001fdef', 'invalid-characters'],
    ['界'.repeat(TEXT_SEARCH_MAX_CHARACTERS + 1), 'too-long'],
  ])('classifies %j as %s', (input, kind) => {
    expect(classifyTextSearch(input).kind).toBe(kind)
  })

  it('returns only a normalized query that the server may execute', () => {
    expect(activeTextSearch('  café  ')).toBe('café')
    expect(classifyTextSearch('\u0085café\u0085').kind).toBe('invalid-characters')
    expect(activeTextSearch('\uFEFFcafé\uFEFF')).toBe('café')
    expect(activeTextSearch('ab')).toBe('')
  })
})
