import { describe, expect, it } from 'vitest'
import type { RunEvent } from './types'
import {
  dedupeAgentReasoningEvents,
  getInterEventDeltaMs,
  getRunEventPresentation,
  parseCausalReplay,
  parseAgentReasoning,
  sortRunEventsChronologically,
  summarizeRunDiagnostics,
} from './run-timeline'

describe('run event timeline projection', () => {
  it('maps lifecycle families to semantic tones', () => {
    expect(getRunEventPresentation({ id: '1', type: 'node.failed' }).tone).toBe('error')
    expect(getRunEventPresentation({ id: '2', type: 'node.succeeded' }).tone).toBe('success')
    expect(getRunEventPresentation({ id: '3', type: 'node.waiting' }).tone).toBe('warning')
    expect(getRunEventPresentation({ id: '4', type: 'node.running' }).tone).toBe('info')
    expect(getRunEventPresentation({ id: '5', type: 'agent.reasoning' })).toEqual({ tone: 'info', noise: false })
  })

  it('keeps queue and status-check noise visible but marks it for de-emphasis', () => {
    expect(getRunEventPresentation({ id: '1', type: 'node.queued' })).toEqual({ tone: 'neutral', noise: true })
    expect(getRunEventPresentation({ id: '2', type: 'run.status_checked' })).toEqual({ tone: 'neutral', noise: true })
    expect(getRunEventPresentation({ id: '3', type: 'custom.signal' })).toEqual({ tone: 'neutral', noise: false })
  })

  it('parses, bounds, and comprehensively scrubs the stable agent rationale', () => {
    const secret = `sk-ant-${'a'.repeat(24)}`
    const parsed = parseAgentReasoning({
      id: 'reasoning',
      type: 'agent.reasoning',
      nodeId: 'agent',
      payload: {
        agent: `recovery\npostgres://operator:password@db.internal/acme ${'a'.repeat(180)}`,
        iteration: 0,
        planner: 'ai',
        mode: 'ai',
        scope: 'agent',
        replacesEventId: 'planned-1',
        decision: 'use_tool',
        tool: 'db.query.read',
        reason: `Inspect\n${secret} before recovery.`,
      },
    })
    expect(parsed).toMatchObject({
      iteration: 0,
      planner: 'ai',
      mode: 'ai',
      scope: 'agent',
      replacesEventId: 'planned-1',
      decision: 'use_tool',
      tool: 'db.query.read',
      reason: 'Inspect [redacted] before recovery.',
    })
    expect(parsed?.agent).not.toContain('postgres://')
    expect(parsed?.agent).not.toContain('\n')
    expect(parsed?.agent.length).toBeLessThanOrEqual(120)
  })

  it('rejects malformed agent reasoning shapes', () => {
    expect(parseAgentReasoning({
      id: 'bad',
      type: 'agent.reasoning',
      payload: { decision: 'finish', tool: 'must-be-null' },
    })).toBeNull()
  })

  it('deduplicates only the exact legacy planned row named by a valid canonical event', () => {
    const oldLegacy: RunEvent = {
      id: 'old',
      type: 'agent.step.planned',
      nodeId: 'agent',
      payload: { agent: 'agent', iteration: 0, plan: { tool: 'legacy' } },
    }
    const newLegacy: RunEvent = {
      id: 'new',
      type: 'agent.step.planned',
      nodeId: 'agent',
      payload: { agent: 'agent', iteration: 0, plan: { tool: 'current' } },
    }
    const canonical: RunEvent = {
      id: 'canonical',
      type: 'agent.reasoning',
      nodeId: 'agent',
      payload: {
        agent: 'agent', iteration: 0, planner: 'rules', mode: 'rules', scope: 'agent',
        replacesEventId: 'new',
        decision: 'use_tool', tool: 'current', reason: 'Current operational rationale.',
      },
    }
    expect(dedupeAgentReasoningEvents([oldLegacy, newLegacy, canonical]).map(event => event.id))
      .toEqual(['old', 'canonical'])

    const malformed: RunEvent = { id: 'malformed', type: 'agent.reasoning', nodeId: 'agent', payload: { reason: 'partial' } }
    expect(dedupeAgentReasoningEvents([newLegacy, malformed]).map(event => event.id))
      .toEqual(['new', 'malformed'])
  })

  it('deduplicates deterministically when equal timestamps sort the canonical event first', () => {
    const legacy: RunEvent = {
      id: 'z-planned',
      type: 'agent.step.planned',
      nodeId: 'agent',
      createdAt: '2026-07-15T10:00:00.000Z',
      payload: { agent: 'agent', iteration: 0 },
    }
    const canonical: RunEvent = {
      id: 'a-reasoning',
      type: 'agent.reasoning',
      nodeId: 'agent',
      createdAt: '2026-07-15T10:00:00.000Z',
      payload: {
        agent: 'agent', iteration: 0, planner: 'rules', mode: 'rules', scope: 'agent',
        replacesEventId: 'z-planned', decision: 'finish', tool: null, reason: 'Done.',
      },
    }
    const sorted = sortRunEventsChronologically([legacy, canonical])
    expect(sorted.map(event => event.id)).toEqual(['a-reasoning', 'z-planned'])
    expect(dedupeAgentReasoningEvents(sorted).map(event => event.id)).toEqual(['a-reasoning'])
  })

  it('deduplicates legacy rows after applying canonical label normalization', () => {
    const unsafeAgent = `recovery\npostgres://operator:password@db.internal/acme ${'a'.repeat(180)}`
    const legacy: RunEvent = {
      id: 'planned-long-label',
      type: 'agent.step.planned',
      nodeId: 'agent',
      payload: { agent: unsafeAgent, iteration: 0 },
    }
    const canonical: RunEvent = {
      id: 'reasoning-long-label',
      type: 'agent.reasoning',
      nodeId: 'agent',
      payload: {
        agent: unsafeAgent,
        iteration: 0,
        planner: 'rules',
        mode: 'rules',
        scope: 'agent',
        replacesEventId: 'planned-long-label',
        decision: 'finish',
        tool: null,
        reason: 'Done.',
      },
    }

    expect(dedupeAgentReasoningEvents([legacy, canonical]).map(event => event.id))
      .toEqual(['reasoning-long-label'])
  })

  it('computes chronological deltas and rejects malformed or reversed timestamps', () => {
    const previous = { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' }
    expect(getInterEventDeltaMs(previous, { id: '2', type: 'node.running', createdAt: '2026-07-12T10:00:01.250Z' })).toBe(1_250)
    expect(getInterEventDeltaMs(previous, { id: '3', type: 'node.running', createdAt: 'bad' })).toBeNull()
    expect(getInterEventDeltaMs(previous, { id: '4', type: 'node.running', createdAt: '2026-07-12T09:59:59.000Z' })).toBeNull()
  })

  it('normalizes API-descending and streamed event order without mutating the input', () => {
    const events: RunEvent[] = [
      { id: '3', type: 'run.failed', createdAt: '2026-07-12T10:00:03.000Z' },
      { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: '2', type: 'node.running', createdAt: '2026-07-12T10:00:01.000Z' },
    ]
    expect(sortRunEventsChronologically(events).map(event => event.id)).toEqual(['1', '2', '3'])
    expect(events.map(event => event.id)).toEqual(['3', '1', '2'])
  })

  it('summarizes only honest loaded-history diagnostics and ignores malformed recall counts', () => {
    expect(summarizeRunDiagnostics([
      { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: '2', type: 'node.retry', nodeId: 'fetch', createdAt: '2026-07-12T10:00:01.000Z' },
      { id: '3', type: 'node.failed', nodeId: 'fetch', createdAt: '2026-07-12T10:00:02.000Z' },
      { id: '4', type: 'decision.made', nodeId: 'route', createdAt: '2026-07-12T10:00:03.000Z' },
      { id: '5', type: 'agent.memory.recalled', nodeId: 'agent', payload: { count: 3 }, createdAt: '2026-07-12T10:00:04.500Z' },
      { id: '6', type: 'agent.memory.recalled', nodeId: 'agent', payload: { count: -1 }, createdAt: 'bad' },
    ])).toEqual({
      loadedEvents: 6,
      observedDurationMs: 4_500,
      retryCount: 1,
      failedNodeCount: 1,
      decisionCount: 1,
      recalledEpisodeCount: 3,
    })
  })

  it('parses a complete causal replay and rejects partial server shapes', () => {
    const candidate = {
      nodeId: 'fast_path',
      score: 2.5,
      breakdown: { cost: 0.01, latency: 25, quality: 0.98, penalty: 0.02 },
    }
    expect(parseCausalReplay({ chosen: candidate, best: candidate, ranking: [candidate] }))
      .toEqual({ chosen: candidate, best: candidate, ranking: [candidate] })
    expect(parseCausalReplay({ chosen: candidate, ranking: [{ ...candidate, score: 'bad' }] })).toBeNull()
    expect(parseCausalReplay({ chosen: candidate, ranking: [candidate, { nodeId: 'partial' }] })).toBeNull()
    expect(parseCausalReplay({ chosen: null, best: candidate, ranking: [candidate] })).toBeNull()
    expect(parseCausalReplay({ chosen: candidate, best: null, ranking: [candidate] })).toBeNull()
    expect(parseCausalReplay({
      chosen: { ...candidate, nodeId: 'outside' },
      best: candidate,
      ranking: [candidate],
    })).toBeNull()
    expect(parseCausalReplay({
      chosen: candidate,
      best: { ...candidate, score: 3 },
      ranking: [candidate],
    })).toBeNull()
    expect(parseCausalReplay({ chosen: candidate, best: candidate, ranking: [candidate, candidate] })).toBeNull()
    expect(parseCausalReplay({
      chosen: candidate,
      best: { ...candidate, nodeId: 'slow_path', score: 3 },
      ranking: [{ ...candidate, nodeId: 'slow_path', score: 3 }, candidate],
    })).toBeNull()
    expect(parseCausalReplay({ ranking: [] })).toBeNull()
  })
})
