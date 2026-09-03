import { describe, expect, it } from 'vitest'

import { rankPaletteMatches, scorePaletteMatch } from './command-palette-search'

describe('command palette fuzzy search', () => {
  it('matches non-contiguous workflow initials', () => {
    expect(scorePaletteMatch('rftx', 'Refund triage Exploit')).not.toBeNull()
  })

  it('ranks an exact substring above a fuzzy match', () => {
    const ranked = rankPaletteMatches('refund', [
      { item: 'fuzzy', label: 'Risk evaluation for urgent nightly delivery' },
      { item: 'exact', label: 'Refund triage' },
    ])

    expect(ranked).toEqual(['exact', 'fuzzy'])
  })

  it('keeps the exact tier above fuzzy matches for very long labels', () => {
    const ranked = rankPaletteMatches('run', [
      { item: 'fuzzy', label: 'Risk urgent nightly' },
      { item: 'exact', label: `${'x'.repeat(1_000)} run` },
    ])

    expect(ranked).toEqual(['exact', 'fuzzy'])
  })

  it('matches without case sensitivity', () => {
    expect(scorePaletteMatch('RFTX', 'refund TRIAGE exploit')).not.toBeNull()
  })

  it('matches localized labels without requiring diacritics or host-locale casing', () => {
    expect(scorePaletteMatch('recuperacion', 'Centro de Recuperación')).not.toBeNull()
    expect(scorePaletteMatch('ai', 'AI Studio')).not.toBeNull()
    expect(scorePaletteMatch('i', 'İnbox')).not.toBeNull()
  })

  it('prefers compact fuzzy matches with smaller gaps', () => {
    const ranked = rankPaletteMatches('rft', [
      { item: 'wide', label: 'Refund fulfillment timeline' },
      { item: 'compact', label: 'Refund triage' },
    ])

    expect(ranked[0]).toBe('compact')
  })

  it('returns only the strongest five matches', () => {
    const ranked = rankPaletteMatches(
      'flow',
      Array.from({ length: 8 }, (_, index) => ({ item: index, label: `Flow ${index}` })),
    )

    expect(ranked).toHaveLength(5)
    expect(ranked).toEqual([0, 1, 2, 3, 4])
  })
})
