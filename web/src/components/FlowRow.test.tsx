/**
 * Rendering contract for the memoized workflow-list row.
 *
 * The Flows container updates its raw query on every keystroke. A row whose
 * props are unchanged must not render again, while a real row-state change
 * still has to reach the DOM.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { SavedWorkflow } from '../types'
import { FlowRow, type FlowRowProps } from './FlowRow'

vi.mock('./WorkflowHealthBadge', () => ({ WorkflowHealthBadge: () => <button type="button">health</button> }))
vi.mock('./FlowHealthTrend', () => ({ FlowHealthTrend: () => null }))

const noop = () => {}
const renderRow = (row: ReactElement) => render(row, {
  wrapper: ({ children }: { children: ReactNode }) => <table><tbody>{children}</tbody></table>,
})
const t = ((key: string) => key) as FlowRowProps['t']

function props(workflow: SavedWorkflow, selectedIds = new Set<string>()): FlowRowProps {
  return {
    workflow,
    canWrite: true,
    folderOptions: [],
    tagOptions: [],
    hasFolders: false,
    selectionMode: true,
    selectedIds,
    draggingId: null,
    confirmDeleteId: null,
    onOpen: noop,
    toggleSelected: noop,
    setDraggingId: noop,
    setDropTarget: noop,
    setConfirmDeleteId: noop,
    setRowTag: noop,
    moveToFolder: noop,
    deleteWorkflow: noop,
    resumeWorkflow: noop,
    recoveryBusy: false,
    t,
  }
}

describe('<FlowRow /> memoization', () => {
  it('skips stable parent rerenders but renders a changed row-state prop', () => {
    let nameReads = 0
    const workflow = {
      id: 'wf-1',
      orgId: 'org-1',
      get name() {
        nameReads += 1
        return 'Billing sync'
      },
    } as SavedWorkflow
    const stableProps = props(workflow)
    const { rerender } = renderRow(<FlowRow {...stableProps} />)
    const initialReads = nameReads

    rerender(<FlowRow {...stableProps} />)
    expect(nameReads).toBe(initialReads)

    rerender(<FlowRow {...stableProps} selectedIds={new Set(['wf-1'])} />)
    expect(nameReads).toBeGreaterThan(initialReads)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })
})

describe('<FlowRow /> paused state', () => {
  const base: SavedWorkflow = { id: 'wf-1', orgId: 'org-1', name: 'Billing sync' }

  it('shows nothing about pausing for an active workflow', () => {
    renderRow(<FlowRow {...props({ ...base, status: 'active' })} />)
    expect(screen.queryByTestId('workflows-resume-wf-1')).toBeNull()
    expect(screen.queryByText('workflowsDashboard.paused')).toBeNull()
  })

  it('treats a row with no status as active — older cached rows must not render as paused', () => {
    renderRow(<FlowRow {...props(base)} />)
    expect(screen.queryByText('workflowsDashboard.paused')).toBeNull()
    expect(screen.queryByTestId('workflows-resume-wf-1')).toBeNull()
  })

  it('marks a breaker-paused row and offers Resume, carrying the reason as the tooltip', () => {
    renderRow(<FlowRow {...props({
      ...base,
      status: 'paused_circuit_breaker',
      pausedReason: 'Circuit breaker: 5 consecutive failed runs',
    })} />)

    expect(screen.getByText('workflowsDashboard.pausedByBreaker'))
      .toHaveAttribute('title', 'Circuit breaker: 5 consecutive failed runs')
    expect(screen.getByTestId('workflows-resume-wf-1')).toBeInTheDocument()
  })

  it('marks an upstream-paused row but offers NO Resume — that pause clears itself', () => {
    renderRow(<FlowRow {...props({
      ...base,
      status: 'paused_upstream_degraded',
      pausedReason: 'Stripe reports a partial outage',
    })} />)

    expect(screen.getByText('workflowsDashboard.paused')).toBeInTheDocument()
    expect(screen.queryByTestId('workflows-resume-wf-1')).toBeNull()
  })

  it('resumes by id without opening the row', () => {
    const resumeWorkflow = vi.fn()
    const onOpen = vi.fn()
    renderRow(<FlowRow {...props({ ...base, status: 'paused_circuit_breaker' })} resumeWorkflow={resumeWorkflow} onOpen={onOpen} />)

    fireEvent.click(screen.getByTestId('workflows-resume-wf-1'))

    expect(resumeWorkflow).toHaveBeenCalledWith('wf-1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('offers the next buffered page on an active workflow and locks duplicate clicks', () => {
    const resumeWorkflow = vi.fn()
    renderRow(<FlowRow
      {...props({ ...base, status: 'active', bufferedTriggerCount: 9 })}
      resumeWorkflow={resumeWorkflow}
      recoveryBusy
    />)

    const button = screen.getByTestId('workflows-backfill-wf-1')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(resumeWorkflow).not.toHaveBeenCalled()
  })
})

describe('<FlowRow /> labelled cells', () => {
  const base: SavedWorkflow = { id: 'demo-flaky-ingest', orgId: 'org-1', name: 'Flaky ingest' }

  it('shows the slug, open failures, last run, run count and version in their own cells', () => {
    renderRow(<FlowRow {...props({
      ...base,
      lastRunStatus: 'failed',
      lastRunAt: '2026-11-04T12:56:00.000Z',
      runCount: 7,
      openFailureCount: 2,
      currentVersion: 3,
    })} />)

    expect(screen.getByText('demo-flaky-ingest')).toBeInTheDocument()
    const failures = screen.getByTestId('workflows-open-failures-demo-flaky-ingest')
    expect(failures).toHaveTextContent(/^2$/)
    expect(failures).toHaveAttribute('data-open', 'true')
    const lastRun = screen.getByTestId('workflows-last-run-demo-flaky-ingest')
    expect(lastRun.querySelector('time')).toHaveAttribute('dateTime', '2026-11-04T12:56:00.000Z')
    expect(lastRun).toHaveTextContent('workflowsDashboard.runCountTitle')
    expect(failures).not.toHaveTextContent('7')
    expect(screen.getByTestId('workflows-version-demo-flaky-ingest')).toHaveTextContent('v3')
  })

  it('reads as idle and never run when the flow has no runs', () => {
    renderRow(<FlowRow {...props({ ...base, runCount: 0, openFailureCount: 0, currentVersion: 1 })} />)

    expect(screen.getByText('workflowsDashboard.statusIdle')).toBeInTheDocument()
    expect(screen.getByTestId('workflows-last-run-demo-flaky-ingest')).toHaveTextContent('workflowsDashboard.lastRunNever')
    expect(screen.getByTestId('workflows-open-failures-demo-flaky-ingest')).not.toHaveAttribute('data-open')
  })

  it('does not call a paused flow idle', () => {
    renderRow(<FlowRow {...props({ ...base, status: 'paused_upstream_degraded' })} />)

    expect(screen.getByText('workflowsDashboard.paused')).toBeInTheDocument()
    expect(screen.queryByText('workflowsDashboard.statusIdle')).toBeNull()
  })

  it('opens from the row and from the button, but not from delete or the health badge', () => {
    const onOpen = vi.fn()
    const setConfirmDeleteId = vi.fn()
    renderRow(<FlowRow {...props(base)} onOpen={onOpen} setConfirmDeleteId={setConfirmDeleteId} />)

    fireEvent.click(screen.getByTestId('workflows-delete-demo-flaky-ingest'))
    expect(setConfirmDeleteId).toHaveBeenCalledWith('demo-flaky-ingest')
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'health' }))
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'workflowsDashboard.openFlow' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('workflows-row-demo-flaky-ingest'))
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
