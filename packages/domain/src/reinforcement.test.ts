import { describe, expect, it } from 'vitest'
import { applyRlAdjustments, computePreferenceReward } from './reinforcement'

describe('applyRlAdjustments', () => {
  const ranked = [
    { nodeId: 'a', score: 0.5 },
    { nodeId: 'b', score: 0.6 },
  ]

  it('does nothing when disabled', () => {
    const result = applyRlAdjustments(ranked, { a: { nodeId: 'a', pulls: 100, meanReward: 1 } }, { enabled: false })
    expect(result).toEqual(ranked)
  })

  it('shifts score by mean reward * influence after enough pulls', () => {
    const result = applyRlAdjustments(
      ranked,
      { a: { nodeId: 'a', pulls: 10, meanReward: 1 }, b: { nodeId: 'b', pulls: 10, meanReward: -1 } },
      { enabled: true, influence: 0.2, minPulls: 3 },
    )

    const a = result.find(item => item.nodeId === 'a')!
    const b = result.find(item => item.nodeId === 'b')!
    expect(a.score).toBeCloseTo(0.3, 5)
    expect(b.score).toBeCloseTo(0.8, 5)
  })

  it('skips candidates with too few pulls', () => {
    const result = applyRlAdjustments(
      ranked,
      { a: { nodeId: 'a', pulls: 2, meanReward: 1 } },
      { enabled: true, influence: 0.5, minPulls: 5 },
    )
    expect(result.find(item => item.nodeId === 'a')!.score).toBe(0.5)
  })
})

describe('computePreferenceReward', () => {
  it('rewards success', () => {
    const reward = computePreferenceReward({ success: true, latencyMs: 0, cost: 0 })
    expect(reward).toBeGreaterThan(0)
  })

  it('penalizes failure', () => {
    const reward = computePreferenceReward({ success: false, latencyMs: 0, cost: 0 })
    expect(reward).toBeLessThan(0)
  })

  it('factors latency and cost penalties', () => {
    const slow = computePreferenceReward({ success: true, latencyMs: 5000, cost: 0.01 })
    const fast = computePreferenceReward({ success: true, latencyMs: 100, cost: 0 })
    expect(fast).toBeGreaterThan(slow)
  })
})
