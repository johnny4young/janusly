import { describe, expect, it } from 'vitest'

import {
  parseRecoveryHomeSnapshot,
  readRecoveryHomeSection,
} from './recovery-home-snapshot'

describe('recovery Home snapshot wire reader', () => {
  it('retains valid independent sections and ignores malformed additions', () => {
    const snapshot = parseRecoveryHomeSnapshot({
      scope: 'full',
      generatedAt: '2026-07-28T00:00:00.000Z',
      sections: {
        metrics: { status: 'ok', value: { terminalRuns: 2 } },
        validation: { status: 'unavailable' },
        malformed: { status: 'ok' },
      },
    })

    expect(snapshot).not.toBeNull()
    expect(readRecoveryHomeSection(
      snapshot!,
      'metrics',
      value => typeof value === 'object'
        ? value as { terminalRuns: number }
        : null,
    ))
      .toEqual({ terminalRuns: 2 })
    expect(readRecoveryHomeSection(
      snapshot!,
      'validation',
      value => value as never,
    )).toBeNull()
    expect(readRecoveryHomeSection(
      snapshot!,
      'malformed',
      value => value as never,
    )).toBeNull()
  })

  it.each([
    null,
    [],
    { scope: 'other', generatedAt: '', sections: {} },
    { scope: 'full', generatedAt: 7, sections: {} },
    { scope: 'full', generatedAt: '', sections: [] },
  ])('fails closed for malformed envelopes', (value) => {
    expect(parseRecoveryHomeSnapshot(value)).toBeNull()
  })
})
