import { describe, expect, it } from 'vitest'
import { selectRecoveryTimeMetric } from './recovery-metrics'

describe('selectRecoveryTimeMetric', () => {
  it('prefers the versioned verified-recovery metric', () => {
    expect(selectRecoveryTimeMetric({
      mttr: 'legacy-average',
      verifiedRecovery: 'production-median',
    })).toBe('production-median')
  })

  it('falls back to the legacy field for older API responses', () => {
    expect(selectRecoveryTimeMetric({ mttr: 'legacy-average' })).toBe('legacy-average')
  })
})
