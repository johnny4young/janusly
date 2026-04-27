import { describe, expect, it } from 'vitest'
import { decide, scoreCandidate } from './decisionEngine'

describe('scoreCandidate', () => {
  it('rewards low cost, low latency, high success', () => {
    const a = scoreCandidate({ nodeId: 'a', avgCost: 0.001, avgLatencyMs: 100, successRate: 0.95 })
    const b = scoreCandidate({ nodeId: 'b', avgCost: 0.01, avgLatencyMs: 1500, successRate: 0.6 })
    expect(a.score).toBeLessThan(b.score)
  })

  it('respects custom weights', () => {
    const candidate = { nodeId: 'a', avgCost: 1, avgLatencyMs: 1, successRate: 0.5 }
    const cheap = scoreCandidate(candidate, { weightCost: 100, weightLatency: 0, weightQuality: 0 })
    const balanced = scoreCandidate(candidate, { weightCost: 33, weightLatency: 33, weightQuality: 33 })
    expect(cheap.score).not.toBe(balanced.score)
  })
})

describe('decide', () => {
  const candidates = [
    { nodeId: 'fast_path', avgCost: 0.001, avgLatencyMs: 200, successRate: 0.92 },
    { nodeId: 'accurate_path', avgCost: 0.01, avgLatencyMs: 1500, successRate: 0.99 },
  ]

  it('chooses the cheaper option under default auto strategy', async () => {
    const result = await decide({ candidates })
    expect(result.chosenNodeId).toBe('fast_path')
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    expect(result.ranking).toHaveLength(2)
  })

  it('honors strategy=cheapest', async () => {
    const result = await decide({ candidates, strategy: 'cheapest' })
    expect(result.chosenNodeId).toBe('fast_path')
  })

  it('honors strategy=fastest', async () => {
    const result = await decide({ candidates, strategy: 'fastest' })
    expect(result.chosenNodeId).toBe('fast_path')
  })

  it('filters by minSuccessRate', async () => {
    const result = await decide({
      candidates,
      preferences: { minSuccessRate: 0.95 },
    })
    expect(result.chosenNodeId).toBe('accurate_path')
  })

  it('falls back to full pool when constraints filter everything out', async () => {
    const result = await decide({
      candidates,
      preferences: { minSuccessRate: 1.5 },
    })
    expect(result.chosenNodeId).toBeTruthy()
  })

  it('skips candidates above budget', async () => {
    const result = await decide({
      candidates,
      budget: { limitUsd: 0.005 },
    })
    expect(result.chosenNodeId).toBe('fast_path')
  })

  it('returns no candidate when input is empty', async () => {
    const result = await decide({ candidates: [] })
    expect(result.chosenNodeId).toBeUndefined()
    expect(result.confidence).toBe(0)
  })
})
