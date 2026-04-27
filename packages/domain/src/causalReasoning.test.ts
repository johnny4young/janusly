import { describe, expect, it } from 'vitest'
import { replayDecision } from './causalReasoning'

describe('replayDecision', () => {
  const candidates = [
    { nodeId: 'fast', avgCost: 0.001, avgLatencyMs: 200, successRate: 0.9 },
    { nodeId: 'mid', avgCost: 0.005, avgLatencyMs: 800, successRate: 0.95 },
    { nodeId: 'accurate', avgCost: 0.01, avgLatencyMs: 1500, successRate: 0.99 },
  ]

  it('explains the chosen candidate and lists alternatives', () => {
    const result = replayDecision({ chosenNodeId: 'fast', candidates })
    expect(result.chosen?.nodeId).toBe('fast')
    expect(result.best?.nodeId).toBe('fast')
    expect(result.alternatives).toHaveLength(2)
    expect(result.explanation).toContain('Chosen fast')
  })

  it('reports the best candidate even when a different one was chosen', () => {
    const result = replayDecision({ chosenNodeId: 'accurate', candidates, strategy: 'cheapest' })
    expect(result.chosen?.nodeId).toBe('accurate')
    expect(result.best?.nodeId).toBe('fast')
  })

  it('returns a stable shape on empty input', () => {
    const result = replayDecision({ candidates: [] })
    expect(result.chosen).toBeUndefined()
    expect(result.alternatives).toEqual([])
    expect(result.explanation).toContain('No candidate')
  })
})
