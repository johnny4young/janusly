import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ActivityWorkspace } from './ActivityWorkspace'
import type { ActivityWorkspaceProps } from './ActivityWorkspace'
import type { DeadLetter } from './DeadLettersPanel'

vi.mock('./RunWorkspace', () => ({
  RunWorkspace: () => <div>Run detail</div>,
}))

vi.mock('./ActivityRecoveryDetail', () => ({
  ActivityRecoveryDetail: () => <div data-testid="recovery-detail-projection">Recovery detail</div>,
}))

const recovery: DeadLetter = {
  id: 'recovery-browser',
  runId: 'run-browser',
  nodeId: 'request_approval',
  nodeType: 'approval',
  workflowName: 'Refund review',
  attempt: 1,
  status: 'open',
  createdAt: '2026-07-28T12:00:00.000Z',
  errorJson: { message: 'Approval expired' },
}

function props(): ActivityWorkspaceProps {
  return {
    runs: [{
      id: 'run-live',
      workflowId: 'workflow-browser',
      workflowName: 'Refund review',
      status: 'running',
      createdAt: '2026-07-28T11:00:00.000Z',
    }],
    workflows: [{
      id: 'workflow-browser',
      orgId: 'org-browser',
      name: 'Refund review',
    }],
    deadLetters: [recovery],
    usage: {},
    runNodes: [],
    runEvents: [],
    activeRunId: null,
    onOpenRun: vi.fn(),
    onRefreshPlatform: vi.fn(),
    onApproveNode: vi.fn(),
    onSubmitHumanForm: vi.fn(),
    onReplayNode: vi.fn(),
    onRedriveNode: vi.fn(),
    onReplayDeadLetter: vi.fn(),
    onResolveDeadLetter: vi.fn(),
    onOpenFullView: vi.fn(),
    onSelectRecovery: vi.fn(),
    onClearActiveRun: vi.fn(),
    onOpenRecoveryTools: vi.fn(),
  }
}

describe('<ActivityWorkspace /> (browser smoke)', () => {
  it('keeps filters tappable and preserves the inventory beside selected recovery detail', async () => {
    const view = render(
      <div style={{ width: 1100 }}>
        <ActivityWorkspace {...props()} />
      </div>,
    )

    const needsAction = screen.getByTestId('activity-filter-needs_action')
    expect(needsAction.getBoundingClientRect().height).toBeGreaterThanOrEqual(40)

    const recoveryRow = screen.getByTestId('activity-row-recovery:recovery-browser')
    fireEvent.click(recoveryRow.querySelector('button')!)
    const updated = props()
    updated.activeRecoveryId = 'recovery-browser'
    view.rerender(
      <div style={{ width: 1100 }}>
        <ActivityWorkspace {...updated} />
      </div>,
    )
    await waitFor(() => expect(screen.getByTestId('recovery-detail-projection')).toBeVisible())

    const feedBox = screen.getByTestId('activity-feed-list').closest('section')!.getBoundingClientRect()
    const detailBox = screen.getByTestId('activity-detail').getBoundingClientRect()
    expect(detailBox.x).toBeGreaterThanOrEqual(feedBox.x + feedBox.width)
    expect(screen.getByTestId('activity-feed-list')).toBeVisible()
  })

  it('focuses newly opened recovery evidence without adding a tab stop', async () => {
    const view = render(<ActivityWorkspace {...props()} />)
    fireEvent.click(screen.getByTestId('activity-row-recovery:recovery-browser').querySelector('button')!)
    const updated = props()
    updated.activeRecoveryId = 'recovery-browser'
    view.rerender(<ActivityWorkspace {...updated} />)

    const panel = await screen.findByTestId('activity-detail')
    await waitFor(() => expect(document.activeElement).toBe(panel))
    expect(panel).toHaveAttribute('tabindex', '-1')
  })

  it('scrolls offscreen detail into view but leaves visible detail in place', async () => {
    const originalRect = Element.prototype.getBoundingClientRect
    const originalScroll = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    Element.prototype.getBoundingClientRect = function () {
      const bounds = originalRect.call(this) as DOMRect
      if ((this as HTMLElement).dataset?.testid === 'activity-detail') {
        return { ...bounds, top: window.innerHeight + 200, bottom: window.innerHeight + 900 } as DOMRect
      }
      return bounds
    }
    try {
      const view = render(<ActivityWorkspace {...props()} />)
      const updated = props()
      updated.activeRecoveryId = 'recovery-browser'
      view.rerender(<ActivityWorkspace {...updated} />)
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce())
    } finally {
      Element.prototype.getBoundingClientRect = originalRect
      Element.prototype.scrollIntoView = originalScroll
    }
  })

  it('keeps every activity row field inside the fixed virtualized card on mobile', () => {
    render(
      <div style={{ width: 430 }}>
        <ActivityWorkspace {...props()} />
      </div>,
    )

    for (const row of screen.getAllByRole('article')) {
      const rowBox = row.getBoundingClientRect()
      const contentBottom = Math.max(
        ...[...row.querySelectorAll<HTMLElement>(
          '.we-activity-row__primary, .we-activity-row__status, .we-activity-row__next, code',
        )].map(element => element.getBoundingClientRect().bottom),
      )
      expect(contentBottom).toBeLessThanOrEqual(rowBox.bottom + 1)
    }
  })
})
