import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readDeadLetterDetail } from '../lib/dead-letter-contract'
import type { ActivityWorkspaceProps } from './ActivityWorkspace'
import { ActivityWorkspace } from './ActivityWorkspace'
import type { DeadLetter } from './DeadLettersPanel'
import { requestRecoveryQueueFocus } from './recovery-queue-focus-bus'

vi.mock('../lib/dead-letter-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/dead-letter-contract')>()),
  readDeadLetterDetail: vi.fn(),
}))

vi.mock('./RunWorkspace', () => ({
  RunWorkspace: ({ runsPanelVariant }: { runsPanelVariant?: string }) => (
    <div data-testid="run-detail-projection">{runsPanelVariant ?? 'standalone'}</div>
  ),
}))

vi.mock('./ActivityRecoveryDetail', () => ({
  ActivityRecoveryDetail: ({ deadLetter }: { deadLetter: DeadLetter }) => (
    <div data-testid="recovery-detail-projection">{deadLetter.nodeId}</div>
  ),
}))

const handlers = {
  onOpenRun: vi.fn(),
  onRefreshPlatform: vi.fn(),
  onApproveNode: vi.fn(),
  onSubmitHumanForm: vi.fn(),
  onReplayNode: vi.fn(),
  onRedriveNode: vi.fn(),
  onCancelActiveRun: vi.fn(),
  onReplayDeadLetter: vi.fn(),
  onResolveDeadLetter: vi.fn(),
  onOpenFullView: vi.fn(),
  onSelectRecovery: vi.fn(),
  onClearActiveRun: vi.fn(),
  onOpenRecoveryTools: vi.fn(),
}

const deadLetter: DeadLetter = {
  id: 'dead-letter-1',
  runId: 'run-failed',
  nodeId: 'notify_finance',
  nodeType: 'approval',
  workflowName: 'Invoice recovery',
  attempt: 1,
  status: 'open',
  createdAt: '2026-07-28T12:00:00.000Z',
  errorJson: { message: 'Approval timed out' },
}

function offListDetail(id: string): Awaited<ReturnType<typeof readDeadLetterDetail>> {
  return {
    id, orgId: 'org-1', runId: 'run-failed', nodeId: `node-${id}`,
    attempt: 1, status: 'open', workflowJson: {}, nodeJson: {}, errorJson: {},
    createdAt: null, replayedAt: null, replayClaimedAt: null,
    suspectVersion: null, drill: null, drillOutcome: null,
  }
}

function props(
  overrides: Partial<ActivityWorkspaceProps> = {},
): ActivityWorkspaceProps {
  return {
    ...handlers,
    runs: [
      {
        id: 'run-live',
        workflowId: 'workflow-1',
        workflowName: 'Invoice recovery',
        status: 'running',
        createdAt: '2026-07-28T11:00:00.000Z',
      },
      {
        id: 'run-waiting',
        workflowId: 'workflow-1',
        workflowName: 'Invoice recovery',
        status: 'running',
        hasWaitingNodes: true,
        createdAt: '2026-07-28T10:00:00.000Z',
      },
    ],
    workflows: [{ id: 'workflow-1', orgId: 'org-1', name: 'Invoice recovery' }],
    deadLetters: [deadLetter],
    usage: {},
    runNodes: [],
    runEvents: [],
    activeRunId: null,
    ...overrides,
  }
}

describe('<ActivityWorkspace />', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    for (const handler of Object.values(handlers)) handler.mockClear()
    vi.mocked(readDeadLetterDetail).mockReset()
  })

  it('shows the unified inventory before any run or recovery tools', () => {
    render(<ActivityWorkspace {...props()} />)

    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByTestId('activity-feed-list')).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.queryByTestId('activity-detail')).not.toBeInTheDocument()
    expect(screen.queryByText('Ask Janusly')).not.toBeInTheDocument()
  })

  it('filters needs-action work and gives each row a clear next action', () => {
    render(<ActivityWorkspace {...props()} />)

    fireEvent.click(screen.getByTestId('activity-filter-needs_action'))

    expect(screen.getByTestId('activity-row-recovery:dead-letter-1')).toHaveTextContent('Recover this step')
    expect(screen.getByTestId('activity-row-run:run-waiting')).toHaveTextContent('Review waiting step')
    expect(screen.getByTestId('activity-row-run:run-waiting')).toHaveTextContent('Needs action')
    expect(screen.queryByTestId('activity-row-run:run-live')).not.toBeInTheDocument()
  })

  it('refreshes the shared platform projection on demand', () => {
    render(<ActivityWorkspace {...props()} />)

    fireEvent.click(screen.getByTestId('activity-refresh'))

    expect(handlers.onRefreshPlatform).toHaveBeenCalledOnce()
  })

  it('opens detailed history without discarding the active run context', async () => {
    render(<ActivityWorkspace {...props({ activeRunId: 'run-live' })} />)

    fireEvent.click(screen.getByTestId('activity-open-run-history'))

    expect(await screen.findByTestId('activity-run-history')).toBeVisible()
    expect(handlers.onClearActiveRun).not.toHaveBeenCalled()
  })

  it('opens run and recovery detail in context while preserving the feed', async () => {
    const view = render(<ActivityWorkspace {...props()} />)

    fireEvent.click(screen.getByTestId('activity-row-run:run-live').querySelector('button')!)
    expect(handlers.onOpenRun).toHaveBeenCalledWith('run-live')

    view.rerender(<ActivityWorkspace {...props({ activeRunId: 'run-live' })} />)
    expect(await screen.findByTestId('run-detail-projection')).toHaveTextContent('activity-detail')
    expect(screen.getByTestId('activity-feed-list')).toBeVisible()

    fireEvent.click(screen.getByTestId('activity-row-recovery:dead-letter-1').querySelector('button')!)
    view.rerender(<ActivityWorkspace {...props({ activeRecoveryId: 'dead-letter-1' })} />)
    expect(await screen.findByTestId('recovery-detail-projection')).toHaveTextContent('notify_finance')
    expect(handlers.onSelectRecovery).toHaveBeenCalledWith('dead-letter-1')
    expect(handlers.onClearActiveRun).toHaveBeenCalled()
    expect(screen.getByTestId('activity-feed-list')).toBeVisible()
  })

  it('adopts a recovery attention handoff into the needs-action filter', async () => {
    requestRecoveryQueueFocus()
    render(<ActivityWorkspace {...props()} />)

    await waitFor(() => expect(screen.getByTestId('activity-filter-needs_action')).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByTestId('activity-row-recovery:dead-letter-1')).toBeVisible()
    expect(screen.getByTestId('activity-row-run:run-waiting')).toBeVisible()
    expect(screen.queryByTestId('activity-row-run:run-live')).not.toBeInTheDocument()
  })

  it('reads off-list recovery evidence once per selected ID and aborts the previous selection', async () => {
    vi.mocked(readDeadLetterDetail).mockImplementation(() => new Promise(() => {}))
    const initial = props({ activeRecoveryId: 'off-list-1' })
    const view = render(<ActivityWorkspace {...initial} />)

    await waitFor(() => expect(readDeadLetterDetail).toHaveBeenCalledTimes(1))
    const firstSignal = vi.mocked(readDeadLetterDetail).mock.calls[0]![1]
    expect(firstSignal?.aborted).toBe(false)

    view.rerender(<ActivityWorkspace {...initial} />)
    fireEvent.click(screen.getByTestId('activity-filter-failed'))
    expect(readDeadLetterDetail).toHaveBeenCalledTimes(1)
    expect(firstSignal?.aborted).toBe(false)

    view.rerender(<ActivityWorkspace {...initial} activeRecoveryId="off-list-2" />)
    await waitFor(() => expect(readDeadLetterDetail).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)
    expect(vi.mocked(readDeadLetterDetail).mock.calls[1]![0]).toBe('off-list-2')

    const secondSignal = vi.mocked(readDeadLetterDetail).mock.calls[1]![1]
    view.rerender(<ActivityWorkspace {...initial} activeRecoveryId="off-list-2" canReadDeadLetters={false} />)
    expect(secondSignal?.aborted).toBe(true)
    expect(readDeadLetterDetail).toHaveBeenCalledTimes(2)
  })

  it('does not display a previous off-list recovery while a new selection loads', async () => {
    vi.mocked(readDeadLetterDetail)
      .mockResolvedValueOnce(offListDetail('off-list-1'))
      .mockImplementationOnce(() => new Promise(() => {}))
    const initial = props({ activeRecoveryId: 'off-list-1' })
    const view = render(<ActivityWorkspace {...initial} />)
    expect(await screen.findByTestId('recovery-detail-projection')).toHaveTextContent('node-off-list-1')

    view.rerender(<ActivityWorkspace {...initial} canReadDeadLetters={false} />)
    expect(screen.queryByTestId('recovery-detail-projection')).not.toBeInTheDocument()

    view.rerender(<ActivityWorkspace {...initial} activeRecoveryId="off-list-2" />)
    expect(screen.queryByTestId('recovery-detail-projection')).not.toBeInTheDocument()
    expect(screen.getByTestId('activity-detail')).toHaveTextContent('Loading')
    expect(readDeadLetterDetail).toHaveBeenCalledTimes(2)
  })

  it('does not read off-list recovery evidence without read permission', () => {
    render(<ActivityWorkspace {...props({
      activeRecoveryId: 'off-list-1',
      canReadDeadLetters: false,
    })} />)

    expect(readDeadLetterDetail).not.toHaveBeenCalled()
  })
})
