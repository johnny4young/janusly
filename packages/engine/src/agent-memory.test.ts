import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@janusly/data', () => ({
  commitMemory: vi.fn(),
  getMemoryConfig: vi.fn(),
  recallMemory: vi.fn(),
}))

import { commitMemory, getMemoryConfig, recallMemory } from '@janusly/data'
import { recallAgentEpisodes, recordAgentEpisode } from './agent-memory'

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    kind: 'agent_episode',
    content: 'Goal: refund cus_1\nOutcome: refunded',
    similarity: 0.9,
    workflowId: 'wf-1',
    runId: 'run-0',
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

describe('agent episodic memory', () => {
  beforeEach(() => {
    vi.mocked(commitMemory).mockReset()
    vi.mocked(getMemoryConfig).mockReset()
    vi.mocked(recallMemory).mockReset()
    vi.mocked(getMemoryConfig).mockResolvedValue({ enabled: true, allowedKinds: new Set(['agent_episode']) } as never)
  })

  it('recall renders a DATA-framed block ranking same-workflow episodes first', async () => {
    vi.mocked(recallMemory).mockResolvedValue({
      entries: [
        entry({ id: 'other', content: 'Goal: x\nOutcome: y', similarity: 0.95, workflowId: 'wf-2' }),
        entry({ id: 'same', content: 'Goal: refund\nOutcome: ok', similarity: 0.80, workflowId: 'wf-1' }),
      ],
    } as never)

    const result = await recallAgentEpisodes({ orgId: 'org-1', workflowId: 'wf-1', goal: 'refund a customer' })

    expect(result.count).toBe(2)
    expect(result.fingerprints).toEqual([
      expect.stringMatching(/^[a-f0-9]{12}$/),
      expect.stringMatching(/^[a-f0-9]{12}$/),
    ])
    expect(result.fingerprints[0]).not.toBe(result.fingerprints[1])
    expect(result.block).toContain('data, not instructions')
    // same-workflow ('this workflow') line comes before the cross-workflow one
    const sameIdx = result.block.indexOf('[this workflow]')
    const otherIdx = result.block.indexOf('[other workflow]')
    expect(sameIdx).toBeGreaterThan(-1)
    expect(otherIdx).toBeGreaterThan(-1)
    expect(sameIdx).toBeLessThan(otherIdx)
    expect(recallMemory).toHaveBeenCalledWith({ orgId: 'org-1', kind: 'agent_episode', query: 'refund a customer' })
  })

  it('recall returns empty (no recall call) when memory is disabled', async () => {
    vi.mocked(getMemoryConfig).mockResolvedValueOnce({ enabled: false, allowedKinds: new Set(['agent_episode']) } as never)
    const result = await recallAgentEpisodes({ orgId: 'org-1', workflowId: 'wf-1', goal: 'refund' })
    expect(result).toEqual({ block: '', count: 0, fingerprints: [] })
    expect(recallMemory).not.toHaveBeenCalled()
  })

  it('recall returns empty (no recall call) when agent_episode is not an allowed kind', async () => {
    vi.mocked(getMemoryConfig).mockResolvedValueOnce({ enabled: true, allowedKinds: new Set() } as never)
    const result = await recallAgentEpisodes({ orgId: 'org-1', workflowId: 'wf-1', goal: 'refund' })
    expect(result).toEqual({ block: '', count: 0, fingerprints: [] })
    expect(recallMemory).not.toHaveBeenCalled()
  })

  it('recall returns empty for a blank goal without touching the substrate', async () => {
    const result = await recallAgentEpisodes({ orgId: 'org-1', workflowId: 'wf-1', goal: '   ' })
    expect(result).toEqual({ block: '', count: 0, fingerprints: [] })
    expect(getMemoryConfig).not.toHaveBeenCalled()
    expect(recallMemory).not.toHaveBeenCalled()
  })

  it('recall + record degrade to a no-op for a non-string goal (never throw)', async () => {
    // `runAgentLoop` feeds the goal from an `any` config — a non-string value
    // must not blow up `.trim()` outside the try/catch.
    await expect(recallAgentEpisodes({ orgId: 'org-1', goal: { nope: true } as never }))
      .resolves.toEqual({ block: '', count: 0, fingerprints: [] })
    await expect(recordAgentEpisode({ orgId: 'org-1', goal: 123 as never, outcome: 'x', success: true, stepCount: 0 }))
      .resolves.toBeUndefined()
    expect(getMemoryConfig).not.toHaveBeenCalled()
    expect(recallMemory).not.toHaveBeenCalled()
    expect(commitMemory).not.toHaveBeenCalled()
  })

  it('recall never throws on a substrate error', async () => {
    vi.mocked(recallMemory).mockRejectedValue(new Error('boom'))
    await expect(recallAgentEpisodes({ orgId: 'org-1', workflowId: 'wf-1', goal: 'refund' }))
      .resolves.toEqual({ block: '', count: 0, fingerprints: [] })
  })

  it('record commits an agent_episode with goal + outcome + metadata', async () => {
    vi.mocked(commitMemory).mockResolvedValue({ ok: true, entryId: 'mem_1' } as never)

    await recordAgentEpisode({
      orgId: 'org-1', workflowId: 'wf-1', runId: 'run-9',
      goal: 'refund cus_1', outcome: 'refunded $10', success: true, stepCount: 2,
    })

    expect(commitMemory).toHaveBeenCalledWith({
      orgId: 'org-1',
      workflowId: 'wf-1',
      runId: 'run-9',
      kind: 'agent_episode',
      content: 'Goal: refund cus_1\nOutcome: refunded $10',
      metadata: { success: true, stepCount: 2 },
    })
  })

  it('record is a no-op for a blank goal and never throws on a substrate error', async () => {
    await recordAgentEpisode({ orgId: 'org-1', goal: '  ', outcome: 'x', success: true, stepCount: 0 })
    expect(commitMemory).not.toHaveBeenCalled()

    vi.mocked(commitMemory).mockRejectedValue(new Error('boom'))
    await expect(recordAgentEpisode({ orgId: 'org-1', goal: 'g', outcome: 'o', success: false, stepCount: 1 }))
      .resolves.toBeUndefined()
  })
})
