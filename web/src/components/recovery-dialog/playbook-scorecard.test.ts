/**
 * The scorecard math, pinned — including the sample floor that keeps a
 * statistically empty "100%" from being a playbook's first impression.
 */

import { describe, expect, it } from 'vitest'

import { PLAYBOOK_SCORECARD_MIN_SAMPLES, resolvePlaybookScorecard } from './playbook-scorecard'

describe('resolvePlaybookScorecard', () => {
  it('computes the rate an ops lead quotes: 87% across 23 outcomes', () => {
    expect(resolvePlaybookScorecard(20, 3)).toEqual({ ratePercent: 87, total: 23 })
  })

  it('withholds the percentage below the sample floor — 100% of one use is noise', () => {
    expect(resolvePlaybookScorecard(1, 0)).toEqual({ ratePercent: null, total: 1 })
    expect(resolvePlaybookScorecard(2, 0)).toEqual({ ratePercent: null, total: 2 })
    expect(resolvePlaybookScorecard(PLAYBOOK_SCORECARD_MIN_SAMPLES, 0)).toEqual({ ratePercent: 100, total: 3 })
  })

  it('a playbook that only regressed reads 0%, not a crash', () => {
    expect(resolvePlaybookScorecard(0, 4)).toEqual({ ratePercent: 0, total: 4 })
  })

  it('clamps negative counters from a corrupt row instead of inventing math', () => {
    expect(resolvePlaybookScorecard(-5, 2)).toEqual({ ratePercent: null, total: 2 })
  })

  it('zero history stays silent', () => {
    expect(resolvePlaybookScorecard(0, 0)).toEqual({ ratePercent: null, total: 0 })
  })
})
