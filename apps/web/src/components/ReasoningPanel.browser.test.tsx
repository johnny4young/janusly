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
          onReplayDecision={replayDecision}
          events={[
            { id: 'e1', type: 'run.started', createdAt: '2026-07-14T12:00:00.000Z' },
            { id: 'e2', type: 'decision.made', nodeId: 'route', createdAt: '2026-07-14T12:00:01.000Z' },
            { id: 'e3', type: 'agent.memory.recalled', nodeId: 'agent', payload: { count: 2 }, createdAt: '2026-07-14T12:00:02.000Z' },
          ]}
        />
      </div>,
    )

    const diagnostics = screen.getByTestId('run-diagnostics')
    expect(diagnostics.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(diagnostics.querySelectorAll('dd')).toHaveLength(6)

    const trigger = screen.getByRole('button', { name: 'What if?' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(getComputedStyle(trigger).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    const loading = screen.getByRole('status')
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
