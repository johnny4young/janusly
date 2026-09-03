import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ReasoningPanel } from './ReasoningPanel'

describe('<ReasoningPanel /> (browser smoke)', () => {
  it('renders diagnostics plus accessible loading and causal-result states in Chromium', async () => {
    let release!: (value: unknown) => void
    const replayDecision = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(
      <div style={{ width: 720, padding: 16 }}>
        <ReasoningPanel
          activeRunId="run-browser"
          onLoadRunUsage={vi.fn().mockResolvedValue({
            loadedRows: 4,
            truncated: false,
            rowCap: 10_000,
            llm: {
              calls: 2,
              inputTokens: 9_000,
              outputTokens: 1_000,
              totalTokens: 10_000,
              cachedInputTokens: 6_000,
              cacheCreationInputTokens: 500,
              knownCostUsd: 0.02,
              unknownCostCalls: 0,
            },
            memory: { recalls: 1, commits: 1, failures: 0, kinds: [] },
          })}
          onReplayDecision={replayDecision}
          events={[
            { id: 'e1', type: 'run.started', createdAt: '2026-07-14T12:00:00.000Z' },
            { id: 'e2', type: 'decision.made', nodeId: 'route', createdAt: '2026-07-14T12:00:01.000Z' },
            { id: 'e3', type: 'agent.memory.recalled', nodeId: 'agent', payload: { count: 2 }, createdAt: '2026-07-14T12:00:02.000Z' },
            {
              id: 'e4',
              type: 'agent.reasoning',
              nodeId: 'agent',
              createdAt: '2026-07-14T12:00:03.000Z',
              payload: {
                agent: 'recovery-agent',
                iteration: 1,
                planner: 'ai',
                mode: 'ai',
                scope: 'agent',
                replacesEventId: 'e-planned',
                decision: 'use_tool',
                tool: 'db.query.read',
                reason: 'The read-only query verifies the invoice state before recovery.',
              },
            },
          ]}
        />
      </div>,
    )

    const diagnostics = screen.getByTestId('run-diagnostics')
    expect(diagnostics.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(diagnostics.querySelectorAll('dd')).toHaveLength(6)
    const resourceUsage = await screen.findByTestId('run-resource-usage')
    await waitFor(() => expect(resourceUsage).toHaveAttribute('data-state', 'ready'))
    expect(resourceUsage).toHaveAttribute('role', 'status')
    expect(resourceUsage).toHaveAttribute('aria-live', 'polite')
    expect(resourceUsage.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(resourceUsage.querySelectorAll('dd')).toHaveLength(7)
    expect(resourceUsage).toHaveTextContent('Cache read6,000')
    const agentReasoning = screen.getByTestId('agent-reasoning-summary')
    expect(agentReasoning).toBeVisible()
    expect(agentReasoning).toHaveAccessibleName('Agent operational rationale')
    expect(agentReasoning).toHaveTextContent('The read-only query verifies the invoice state before recovery.')
    expect(agentReasoning).toHaveTextContent('Tool db.query.read')

    const trigger = screen.getByRole('button', { name: 'What if?' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(getComputedStyle(trigger).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    const loading = screen.getByTestId('causal-analysis')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('data-state', 'loading')
    expect(loading.getBoundingClientRect().height).toBeGreaterThan(0)

    const candidate = {
      nodeId: 'fast_path',
      score: 1.25,
      breakdown: { cost: 0.02, latency: 40, quality: 0.98, penalty: 0.02 },
    }
    release({ chosen: candidate, best: candidate, ranking: [candidate] })

    await waitFor(() => expect(screen.getByTestId('causal-analysis')).toHaveAttribute('data-state', 'ready'))
    const result = screen.getByTestId('causal-analysis')
    expect(result.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(result).display).not.toBe('none')
    expect(screen.getByRole('list', { name: 'Replayed candidate ranking' })).toBeVisible()
  })
})
