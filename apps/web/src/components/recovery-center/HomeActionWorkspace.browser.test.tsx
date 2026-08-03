import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { HomeActionWorkspace } from './HomeActionWorkspace'
import type { RecommendedAction } from './recovery-center-model'

const actions: RecommendedAction[] = [
  {
    id: 'resolve_approvals',
    title: 'Resolve one approval',
    body: 'A refund is waiting for a decision.',
    ctaLabel: 'Open run',
    ctaTab: 'runs',
    severity: 'warning',
  },
  {
    id: 'review_semantic_cases',
    title: 'Review one outcome incident',
    body: 'A declared business outcome did not hold.',
    ctaLabel: 'Review case',
    ctaTab: 'recover',
    severity: 'danger',
  },
]

const activeRuns = [
  {
    id: 'run-waiting',
    status: 'waiting',
    hasWaitingNodes: true,
    workflowName: 'Refund approval',
    createdAt: '2026-07-28T13:00:00.000Z',
  },
  {
    id: 'run-running',
    status: 'running',
    workflowName: 'Invoice monitor',
    createdAt: '2026-07-28T12:00:00.000Z',
  },
]

describe('<HomeActionWorkspace /> (browser smoke)', () => {
  it('keeps the priority inbox and active work distinct without horizontal clipping', () => {
    render(
      <div style={{ width: 1180 }}>
        <HomeActionWorkspace
          actions={actions}
          activeRuns={activeRuns}
          activeRunCount={activeRuns.length}
          onSelectAction={vi.fn()}
          onOpenRun={vi.fn()}
          onOpenActivity={vi.fn()}
        />
      </div>,
    )

    const priority = screen.getByTestId('home-priority-inbox').getBoundingClientRect()
    const active = screen.getByTestId('home-active-work').getBoundingClientRect()
    expect(priority.height).toBeGreaterThan(0)
    expect(active.height).toBeGreaterThan(0)
    expect(
      active.left >= priority.right || active.top >= priority.bottom,
    ).toBe(true)
    expect(screen.getByTestId('home-priority-inbox').scrollWidth)
      .toBeLessThanOrEqual(screen.getByTestId('home-priority-inbox').clientWidth + 1)
    expect(screen.getByTestId('home-active-work').scrollWidth)
      .toBeLessThanOrEqual(screen.getByTestId('home-active-work').clientWidth + 1)

    for (const item of screen.getAllByTestId(/^recovery-center-action-(?!cta-)/)) {
      expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1)
    }
  })

  it('keeps primary handoffs explicit and tappable', () => {
    const onSelectAction = vi.fn()
    const onOpenRun = vi.fn()
    const onOpenActivity = vi.fn()
    render(
      <HomeActionWorkspace
        actions={actions}
        activeRuns={activeRuns}
        activeRunCount={activeRuns.length}
        onSelectAction={onSelectAction}
        onOpenRun={onOpenRun}
        onOpenActivity={onOpenActivity}
      />,
    )

    const approval = screen.getByTestId('recovery-center-action-cta-resolve_approvals')
    const activeRun = screen.getByTestId('home-active-run-run-waiting')
    expect(approval.getBoundingClientRect().height).toBeGreaterThanOrEqual(32)
    expect(activeRun.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)

    fireEvent.click(approval)
    fireEvent.click(activeRun)
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

    expect(onSelectAction).toHaveBeenCalledWith(actions[0])
    expect(onOpenRun).toHaveBeenCalledWith('run-waiting')
    expect(onOpenActivity).toHaveBeenCalledOnce()
  })
})
