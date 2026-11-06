/**
 * Regression coverage for failed-node diagnosis plus the selected-run and
 * waiting-step observability surfaces.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunsPanel } from './RunsPanel'
import type { RunNode, RunSummary } from '../types'
import { useWorkflowStore } from '../store'

const deadLettersProps = vi.hoisted(() => vi.fn())
vi.mock('./DeadLettersPanel', () => ({
  DeadLettersPanel: (props: unknown) => {
    deadLettersProps(props)
    return null
  },
}))
vi.mock('./RunExplainChat', () => ({ RunExplainChat: () => null }))
vi.mock('./UsageSummaryCard', () => ({ UsageSummaryCard: () => null }))
vi.mock('./RunStreamChip', () => ({ RunStreamChip: () => <span>Live</span> }))
vi.mock('./ReplayLabDialog', () => ({ ReplayLabDialog: () => null }))
vi.mock('./ReplayLabForkDialog', () => ({ ReplayLabForkDialog: () => null }))
vi.mock('./ReportDeliveryDialog', () => ({ ReportDeliveryDialog: () => <div role="dialog" aria-label="Send run report" /> }))
vi.mock('./HumanFormDialog', () => ({ HumanFormDialog: () => null }))
vi.mock('../hooks/useVirtualList', () => ({
  useVirtualList: ({ items }: { items: unknown[] }) => ({
    containerRef: { current: null },
    visibleItems: items.map((item, index) => ({ item, index })),
    totalHeight: items.length * 226,
    startOffset: 0,
  }),
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
}

describe('recovery run links', () => {
  it('offers a run link only to an operator who can read runs', () => {
    const { unmount } = render(<RunsPanel {...handlers} mode="recovery" runs={[]} workflows={[]} runNodes={[]} usage={{}} />)
    expect(deadLettersProps.mock.lastCall?.[0]).toMatchObject({ onOpenRun: handlers.onOpenRun })
    unmount()

    render(<RunsPanel {...handlers} mode="recovery" canReadRuns={false} runs={[]} workflows={[]} runNodes={[]} usage={{}} />)
    expect(deadLettersProps.mock.lastCall?.[0]).toMatchObject({ onOpenRun: undefined })
  })
})

describe('selected-run outcome evidence', () => {
  it.each([
    ['semantic_violation', 'Semantic failure'],
    ['semantic_quarantined', 'Outcome blocked'],
    ['semantic_recovering', 'Recovery monitoring'],
    ['semantic_recovered', 'Outcome recovered'],
    ['semantic_accepted_loss', 'Accepted loss'],
  ] as const)('keeps %s visible beside technical status', (outcomeStatus, label) => {
    const run: RunSummary = { id: 'run-outcome', status: 'succeeded', outcomeStatus }
    render(<RunsPanel {...handlers} activeRunId={run.id} runs={[run]} workflows={[]} runNodes={[]} usage={{}} />)

    expect(screen.getByTestId('run-overview')).toHaveTextContent(label)
    expect(screen.getByTestId('active-run-semantic-outcome')).toHaveAttribute('data-outcome-status', outcomeStatus)
  })

  it('does not silently hide a missing validation evidence level', () => {
    const run: RunSummary = { id: 'run-validation', status: 'succeeded', replayMode: 'validation' }
    render(<RunsPanel {...handlers} activeRunId={run.id} runs={[run]} workflows={[]} runNodes={[]} usage={{}} />)

    expect(screen.getByTestId('active-run-validation-evidence')).toHaveTextContent('Evidence unavailable')
    expect(screen.getByTestId('run-validation-evidence-run-validation')).toHaveTextContent('Evidence unavailable')
  })

  it('marks a run that used pinned or mocked data', () => {
    const run: RunSummary = { id: 'run-draft', status: 'succeeded', replayMode: 'validation', validationEvidenceLevel: 'writes_skipped', inputJson: { draftTest: { pins: {} } } }
    const { unmount } = render(<RunsPanel {...handlers} activeRunId={run.id} runs={[run]} workflows={[]} runNodes={[]} usage={{}} />)
    expect(screen.getByTestId('active-run-test-data')).toHaveTextContent('Test data')
    expect(screen.getByTestId('active-run-validation-evidence')).toHaveTextContent('External writes skipped')
    unmount()

    render(<RunsPanel {...handlers} activeRunId="run-plain" runs={[{ id: 'run-plain', status: 'succeeded', inputJson: {} }]} workflows={[]} runNodes={[]} usage={{}} />)
    expect(screen.queryByTestId('active-run-test-data')).toBeNull()
  })
})

beforeEach(() => {
  useWorkflowStore.setState({ activeTab: 'runs', toasts: [] })
  for (const handler of Object.values(handlers)) handler.mockClear()
})

function renderPanel(runNodes: RunNode[]) {
  const props: Parameters<typeof RunsPanel>[0] = {
    ...handlers,
    mode: 'recovery',
    runs: [],
    workflows: [],
    usage: {},
    runNodes,
    activeRunId: 'run-1',
  }
  return { ...render(<RunsPanel {...props} />), props }
}

const failedNode: RunNode = {
  nodeId: 'http_call',
  status: 'failed',
  errorJson: { message: 'HTTP 500 from https://api.example.com/orders' },
  attempts: 3,
  startedAt: '2026-07-09T10:00:00.000Z',
  finishedAt: '2026-07-09T10:00:42.000Z',
}

describe('<RunsPanel /> failed-node card', () => {
  it('renders the error message and attempt · duration meta for a failed node', () => {
    renderPanel([failedNode])

    const card = screen.getByTestId('failed-node-http_call')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('HTTP 500 from https://api.example.com/orders')
    expect(card).toHaveTextContent('attempt 3')
    expect(card).toHaveTextContent('42s')
  })

  it('still renders the retry action and wires it to onReplayNode', () => {
    const { props } = renderPanel([failedNode])

    fireEvent.click(screen.getByText('Retry http_call'))
    expect(props.onReplayNode).toHaveBeenCalledWith('http_call')
  })

  it('omits the meta line when the row carries no attempts or timestamps', () => {
    renderPanel([{ nodeId: 'bare', status: 'failed', errorJson: { message: 'boom' } }])

    const card = screen.getByTestId('failed-node-bare')
    expect(card).toHaveTextContent('boom')
    expect(card).not.toHaveTextContent('attempt')
  })

  it('formats a multi-minute duration as `Nm Ns`', () => {
    renderPanel([{
      ...failedNode,
      nodeId: 'slow',
      startedAt: '2026-07-09T10:00:00.000Z',
      finishedAt: '2026-07-09T10:01:20.000Z',
    }])

    expect(screen.getByTestId('failed-node-slow')).toHaveTextContent('1m 20s')
  })

  it('keeps mutation controls out of the DOM when effective permissions deny them', () => {
    render(
      <RunsPanel
        {...handlers}
        mode="recovery"
        activeRunId="run-1"
        workflows={[]}
        runs={[{ id: 'run-1', status: 'failed' }]}
        runNodes={[
          failedNode,
          { nodeId: 'approval', status: 'waiting', stateJson: { waiting: { kind: 'approval' } } },
        ]}
        usage={{}}
        canStartRuns={false}
        canCancelRuns={false}
        canReplayDeadLetters={false}
        canResolveDeadLetters={false}
        canUseRecovery={false}
      />,
    )

    expect(screen.queryByText('Retry http_call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('redrive-node-http_call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('active-run-replay-in-lab')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve and resume' })).not.toBeInTheDocument()
  })
})

describe('<RunsPanel /> observability', () => {
  it('renders selected-run identity, timing, trace correlation, and trigger cause', () => {
    render(
      <RunsPanel
        {...handlers}
        activeRunId="run-1234567890"
        workflows={[]}
        runs={[{
          id: 'run-1234567890',
          status: 'failed',
          workflowVersionId: 'version-abcdef1234',
          traceId: 'trace-abcdef1234',
          createdAt: '2026-07-12T10:00:00.000Z',
          inputJson: {
            workflow: { id: 'billing', name: 'Billing recovery' },
            input: { invoiceId: 'inv-42' },
          },
        }]}
        runNodes={[{ nodeId: 'fetch', status: 'failed', finishedAt: '2026-07-12T10:00:05.000Z' }]}
        usage={{}}
      />,
    )

    expect(screen.getByTestId('run-overview')).toHaveTextContent('Billing recovery')
    expect(screen.getByTestId('run-overview').querySelector('[data-status="failed"]')).toHaveTextContent('Needs attention')
    expect(screen.getByTestId('run-overview')).toHaveTextContent('5s')
    expect(screen.getByRole('button', { name: 'Copy trace ID' })).toBeInTheDocument()
    expect(screen.getByTestId('run-trigger-input')).toHaveTextContent('inv-42')
  })

  it('keeps the data row and every run action in the sheet header', () => {
    const onClose = vi.fn()
    const dropped = vi.fn()
    render(
      <RunsPanel
        {...handlers}
        activeRunId="run-1234567890"
        workflows={[]}
        runs={[{
          id: 'run-1234567890',
          status: 'succeeded',
          workflowVersionId: 'version-abcdef1234',
          traceId: 'trace-abcdef1234',
          createdAt: '2026-07-12T10:00:00.000Z',
          outputJson: { total: 42 },
          parentRunId: 'source-run-id-1',
        }]}
        runNodes={[]}
        usage={{}}
        onClose={onClose}
        renderSheet={({ header, overview }) => {
          dropped(overview)
          return header
        }}
      />,
    )

    const header = screen.getByTestId('run-overview')
    for (const fact of ['Status', 'Duration', 'Started', 'Version reference', 'Trace ID', 'Run ID']) {
      expect(header).toHaveTextContent(fact)
    }
    expect(screen.getByTestId('run-sheet-status')).toHaveTextContent('Done')
    expect(screen.getByTestId('active-run-replay-in-lab')).toBeInTheDocument()
    expect(screen.getByTestId('run-sheet-export')).toHaveAccessibleName(/run-1234567890/)
    expect(screen.getByTestId('run-sheet-send')).toHaveAccessibleName(/run-1234567890/)
    fireEvent.click(screen.getByTestId('run-sheet-source-run'))
    expect(handlers.onOpenRun).toHaveBeenCalledWith('source-run-id-1')
    fireEvent.click(screen.getByTestId('run-sheet-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Outputs belong to the overview slot, and a finished run offers no cancel.
    expect(header).not.toHaveTextContent('Workflow output')
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
    expect(dropped).toHaveBeenCalled()
  })

  it('opens the sheet dialogs from the header while another tab replaces the overview', () => {
    render(
      <RunsPanel
        {...handlers}
        activeRunId="run-1"
        workflows={[]}
        runs={[{ id: 'run-1', status: 'succeeded' }]}
        runNodes={[]}
        usage={{}}
        renderSheet={({ header }) => header}
      />,
    )

    fireEvent.click(screen.getByTestId('run-sheet-send'))

    expect(screen.getByRole('dialog', { name: 'Send run report' })).toBeInTheDocument()
  })

  it('offers cancel only while the run can still stop', () => {
    render(
      <RunsPanel
        {...handlers}
        activeRunId="run-1"
        workflows={[]}
        runs={[{ id: 'run-1', status: 'running' }]}
        runNodes={[]}
        usage={{}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))

    expect(handlers.onCancelActiveRun).toHaveBeenCalledTimes(1)
  })

  it('labels approval and timer waits with actionable copy and timing', () => {
    render(
      <RunsPanel
        {...handlers}
        mode="recovery"
        activeRunId="run-1"
        workflows={[]}
        runs={[{ id: 'run-1', status: 'running', createdAt: new Date(Date.now() - 10_000).toISOString() }]}
        runNodes={[
          {
            nodeId: 'approve_refund',
            status: 'waiting',
            startedAt: new Date(Date.now() - 5_000).toISOString(),
            stateJson: {
              waiting: {
                kind: 'approval',
                title: 'Approve refund',
                description: 'Check the evidence',
                assignee: 'operator-1',
                deadlineAt: new Date(Date.now() + 120_000).toISOString(),
                onTimeout: 'escalate',
                escalateTo: 'operator-2',
              },
            },
          },
          {
            nodeId: 'cooldown',
            status: 'waiting',
            startedAt: new Date(Date.now() - 3_000).toISOString(),
            stateJson: { waiting: { kind: 'timer', wakeAt: new Date(Date.now() + 60_000).toISOString() } },
          },
          {
            nodeId: 'child_flow',
            status: 'waiting',
            startedAt: new Date(Date.now() - 2_000).toISOString(),
            stateJson: { waiting: { kind: 'subworkflow' } },
          },
        ]}
        usage={{}}
      />,
    )

    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Approval')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveAttribute('data-wait-kind', 'approval')
    expect(screen.getByTestId('waiting-step-approve_refund').querySelector('.we-pill')).toHaveAttribute('data-tone', 'warning')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Approve refund')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Check the evidence')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Responsible: operator-1')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Decision due in')
    expect(screen.getByTestId('waiting-step-approve_refund')).toHaveTextContent('Escalates to operator-2 if unanswered')
    expect(screen.getByRole('button', { name: 'Approve and resume' })).toBeInTheDocument()
    expect(screen.getByTestId('waiting-step-cooldown')).toHaveTextContent('Timer')
    expect(screen.getByTestId('waiting-step-cooldown')).toHaveAttribute('data-wait-kind', 'timer')
    expect(screen.getByTestId('waiting-step-cooldown').querySelector('.we-pill')).toHaveAttribute('data-tone', 'warning')
    expect(screen.getByTestId('waiting-step-cooldown')).toHaveTextContent('Wakes in')
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeInTheDocument()
    expect(screen.getByTestId('waiting-step-child_flow')).toHaveTextContent('Resumes automatically when the subworkflow finishes')
    expect(screen.getByTestId('waiting-step-child_flow').querySelector('button')).not.toBeInTheDocument()
  })

  it('shows the exact tool call and records a bound decision', () => {
    const onApproveNode = vi.fn()
    const node: RunNode = {
      nodeId: 'snooze',
      status: 'waiting',
      stateJson: {
        waiting: {
          kind: 'tool_approval',
          reason: 'Waiting for human approval',
          approvalId: 'approval-1',
          tool: 'pagerduty.incident.snooze',
          params: { incident_id: 'Q1X2YZ', token: '[REDACTED]' },
          paramsDigest: 'digest-1',
          maskedPaths: ['token'],
          requiredApprovals: 1,
          deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        },
      },
    }
    const { rerender } = render(
      <RunsPanel {...handlers} onApproveNode={onApproveNode} mode="recovery" activeRunId="run-1" workflows={[]}
        runs={[{ id: 'run-1', status: 'running' }]} runNodes={[node]} usage={{}} />,
    )

    const card = screen.getByTestId('waiting-step-snooze')
    expect(card).toHaveAttribute('data-wait-kind', 'tool_approval')
    expect(card).toHaveTextContent('Tool approval')
    expect(screen.getByTestId('tool-approval-tool-snooze')).toHaveTextContent('pagerduty.incident.snooze')
    expect(screen.getByTestId('tool-approval-params-snooze')).toHaveTextContent('"incident_id": "Q1X2YZ"')
    expect(screen.getByTestId('tool-approval-params-snooze')).toHaveTextContent('[REDACTED]')
    expect(screen.getByTestId('tool-approval-masked-snooze')).toHaveTextContent('Hidden values in this call: token')
    expect(screen.getByTestId('tool-approval-policy-snooze')).toHaveTextContent('Self-approvalNot allowed')
    expect(card).toHaveTextContent('Decision due in')
    expect(screen.queryByRole('button', { name: 'Approve and resume' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('tool-approval-deny-snooze'))
    fireEvent.click(screen.getByTestId('tool-approval-approve-snooze'))
    expect(onApproveNode.mock.calls).toEqual([
      ['snooze', { approvalId: 'approval-1', paramsDigest: 'digest-1', decision: 'deny' }],
      ['snooze', { approvalId: 'approval-1', paramsDigest: 'digest-1', decision: 'approve' }],
    ])

    rerender(
      <RunsPanel {...handlers} onApproveNode={onApproveNode} canStartRuns={false} mode="recovery" activeRunId="run-1"
        workflows={[]} runs={[{ id: 'run-1', status: 'running' }]} runNodes={[node]} usage={{}} />,
    )
    expect(screen.queryByTestId('tool-approval-approve-snooze')).not.toBeInTheDocument()
    expect(screen.getByTestId('tool-approval-params-snooze')).toBeInTheDocument()
  })

  it('mounts the owner live region before announcing an SSE escalation update', () => {
    const assigned: RunNode = {
      nodeId: 'gate',
      status: 'waiting',
      stateJson: { waiting: { kind: 'approval', assignee: 'operator-1' } },
    }
    const { rerender, props } = renderPanel([assigned])
    const announcement = screen.getByTestId('waiting-owner-announcement-gate')
    expect(announcement).toBeEmptyDOMElement()
    expect(announcement).toHaveAttribute('role', 'status')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
    expect(announcement).toHaveAttribute('aria-atomic', 'true')

    rerender(<RunsPanel {...props} runNodes={[{
      ...assigned,
      stateJson: {
        waiting: {
          kind: 'approval',
          assignee: 'operator-2',
          escalatedFrom: 'operator-1',
          timeoutState: 'escalated',
        },
      },
    }]} />)

    expect(screen.getByTestId('waiting-owner-gate')).toHaveTextContent('Escalated from operator-1 to operator-2')
    expect(announcement).toHaveTextContent('Escalated from operator-1 to operator-2')
  })

  it('pre-mounts the owner live region when an approval starts unassigned', () => {
    const unassigned: RunNode = {
      nodeId: 'gate',
      status: 'waiting',
      stateJson: { waiting: { kind: 'approval' } },
    }
    const { rerender, props } = renderPanel([unassigned])
    const announcement = screen.getByTestId('waiting-owner-announcement-gate')
    expect(announcement).toBeEmptyDOMElement()

    rerender(<RunsPanel {...props} runNodes={[{
      ...unassigned,
      stateJson: {
        waiting: {
          kind: 'approval',
          assignee: 'operator-2',
          timeoutState: 'escalated',
        },
      },
    }]} />)

    expect(screen.getByTestId('waiting-owner-gate')).toHaveTextContent('Escalated from unassigned to operator-2')
    expect(announcement).toHaveTextContent('Escalated from unassigned to operator-2')
  })
})
