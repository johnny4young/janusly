import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ActivityWorkspace } from './ActivityWorkspace'
import type { ActivityWorkspaceProps } from './ActivityWorkspace'
import type { DeadLetter } from './DeadLettersPanel'
import { leadingAccents } from '../test/leading-accent'

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

    fireEvent.click(screen.getByTestId('activity-open-recovery:recovery-browser'))
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
    fireEvent.click(screen.getByTestId('activity-open-recovery:recovery-browser'))
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

  // 1200: every column; 700 and 430: two-line rows, as beside open detail and on a phone.
  it.each([1200, 700, 430])('keeps every field inside the 44 px virtualized row at %i px', width => {
    render(
      <div style={{ width }}>
        <ActivityWorkspace {...props()} />
      </div>,
    )

    const rows = screen.getByTestId('activity-feed-list').querySelectorAll<HTMLElement>('[data-testid^="activity-row-"]')
    expect(rows).toHaveLength(2)
    expect(screen.getAllByRole('columnheader')).toHaveLength(7)
    for (const row of rows) {
      const rowBox = row.getBoundingClientRect()
      expect(rowBox.height).toBe(44)
      for (const cell of row.querySelectorAll<HTMLElement>('[role="cell"]')) {
        if (getComputedStyle(cell).display === 'none') continue
        const box = cell.getBoundingClientRect()
        expect(box.bottom).toBeLessThanOrEqual(rowBox.bottom + 1)
        expect(box.top).toBeGreaterThanOrEqual(rowBox.top - 1)
        expect(box.right).toBeLessThanOrEqual(rowBox.right + 1)
      }
    }
  })

  it('selects a row from any cell through its one opener', () => {
    render(<div style={{ width: 1200 }}><ActivityWorkspace {...props()} /></div>)

    const row = screen.getByTestId('activity-row-recovery:recovery-browser')
    expect(row.querySelectorAll('button')).toHaveLength(1)
    row.scrollIntoView()
    const workflow = row.querySelector('.we-activity-cell-workflow')!.getBoundingClientRect()
    const hit = document.elementFromPoint(workflow.x + 8, workflow.y + workflow.height / 2)
    expect(hit).toBe(screen.getByTestId('activity-open-recovery:recovery-browser'))
  })

  it.each([1200, 430])('scrolls a long feed far enough to show and focus its last row at %i px', async width => {
    const runs = Array.from({ length: 40 }, (_, index) => ({
      id: `run-${String(index).padStart(2, '0')}`,
      workflowId: 'workflow-browser',
      workflowName: 'Refund review',
      status: 'succeeded',
      createdAt: new Date(Date.UTC(2026, 6, 28, 11, 59 - index)).toISOString(),
    }))
    render(<div style={{ width }}><ActivityWorkspace {...props()} runs={runs} deadLetters={[]} /></div>)

    const list = screen.getByTestId('activity-feed-list')
    list.scrollTop = list.scrollHeight
    list.dispatchEvent(new Event('scroll'))
    const last = await screen.findByTestId('activity-open-run:run-39')
    last.focus()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(document.activeElement).toBe(last)
    const row = screen.getByTestId('activity-row-run:run-39').getBoundingClientRect()
    expect(row.bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 1)
  })

  // Hidden empty cells must not shift later cells under an earlier header.
  it.each([1200, 430])('ties every cell to its own column header at %i px', width => {
    render(<div style={{ width }}><ActivityWorkspace {...props()} /></div>)

    const table = screen.getByRole('table')
    const headers = [...table.querySelectorAll<HTMLElement>('[role="columnheader"]')]
    expect(table).toHaveAttribute('aria-colcount', String(headers.length))
    const rows = table.querySelectorAll<HTMLElement>('[data-testid^="activity-row-"]')
    for (const row of rows) {
      for (const cell of row.querySelectorAll<HTMLElement>('[role="cell"]')) {
        const header = headers.find(item => item.getAttribute('aria-colindex') === cell.getAttribute('aria-colindex'))
        expect(header?.className).toBe(cell.className)
      }
    }
  })

  it('tints the selected row and leaves the others clear', () => {
    const selected = { ...props(), activeRecoveryId: 'recovery-browser' }
    render(<div style={{ width: 1200 }}><ActivityWorkspace {...selected} /></div>)

    const row = screen.getByTestId('activity-row-recovery:recovery-browser')
    const style = getComputedStyle(row)
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(style.boxShadow).toContain('inset')
    expect(leadingAccents(row.parentElement!)).toEqual([])
    expect(getComputedStyle(screen.getByTestId('activity-row-run:run-live')).backgroundColor)
      .toBe('rgba(0, 0, 0, 0)')
  })
})

describe('programmatic heading focus (browser)', () => {
  it('moves focus to a heading without drawing a ring, and keeps the ring on controls', () => {
    render(<><h2 tabIndex={-1}>Recent activity</h2><a href="#target">Open</a></>)
    const heading = screen.getByRole('heading', { name: 'Recent activity' })
    heading.focus()
    expect(document.activeElement).toBe(heading)
    expect(heading.matches(':focus-visible')).toBe(true)
    expect(getComputedStyle(heading).outlineStyle).toBe('none')

    const link = screen.getByRole('link', { name: 'Open' })
    link.focus()
    expect(link.matches(':focus-visible')).toBe(true)
    expect(getComputedStyle(link).outlineStyle).toBe('solid')
  })
})
