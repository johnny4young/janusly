import { describe, expect, it } from 'vitest'
import { computeConfidence, shouldPromote, shouldRollback } from './improvementEngine'

describe('computeConfidence', () => {
  it('reports improving when success rate climbs', () => {
    const result = computeConfidence(
      { successRate: 0.6, avgLatencyMs: 1000, avgCost: 0.01 },
      { successRate: 0.95, avgLatencyMs: 800, avgCost: 0.005 },
    )
    expect(result.status).toBe('improving')
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('reports regressing when success rate drops', () => {
    const result = computeConfidence(
      { successRate: 0.95, avgLatencyMs: 500, avgCost: 0.005 },
      { successRate: 0.5, avgLatencyMs: 1500, avgCost: 0.02 },
    )
    expect(result.status).toBe('regressing')
  })

  it('clamps confidence to 0..100', () => {
    const result = computeConfidence(
      { successRate: 0, avgLatencyMs: 0, avgCost: 0 },
      { successRate: 100, avgLatencyMs: -5000, avgCost: -1 },
    )
    expect(result.confidence).toBeLessThanOrEqual(100)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
  })

  it('does not let a latency win mask a success-rate regression', () => {
    // Deltas are normalized to the same fractional scale, so a large absolute
    // latency improvement (2000ms -> 1000ms) cannot swamp a sharp success
    // drop (0.9 -> 0.4). Pre-normalization this read as "improving" because
    // raw millisecond deltas dominated the weighted blend.
    const result = computeConfidence(
      { successRate: 0.9, avgLatencyMs: 2000, avgCost: 0.01 },
      { successRate: 0.4, avgLatencyMs: 1000, avgCost: 0.01 },
    )
    expect(result.status).toBe('regressing')
  })
})

describe('shouldRollback / shouldPromote', () => {
  it('rolls back below 30 confidence', () => {
    expect(shouldRollback(20)).toBe(true)
    expect(shouldRollback(50)).toBe(false)
  })

  it('promotes above 70 confidence', () => {
    expect(shouldPromote(80)).toBe(true)
    expect(shouldPromote(50)).toBe(false)
  })
})
