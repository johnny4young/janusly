/**
 * Regression coverage for failed-node diagnosis plus the selected-run and
 * waiting-step observability surfaces.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunsPanel } from './RunsPanel'
import type { RunNode } from '../types'
import { useWorkflowStore } from '../store'

vi.mock('./DeadLettersPanel', () => ({ DeadLettersPanel: () => null }))
vi.mock('./RunExplainChat', () => ({ RunExplainChat: () => null }))
vi.mock('./UsageSummaryCard', () => ({ UsageSummaryCard: () => null }))
vi.mock('./RunStreamChip', () => ({ RunStreamChip: () => <span>Live</span> }))
vi.mock('./ReplayLabDialog', () => ({ ReplayLabDialog: () => null }))
vi.mock('./ReplayLabForkDialog', () => ({ ReplayLabForkDialog: () => null }))
vi.mock('./ReportDeliveryDialog', () => ({ ReportDeliveryDialog: () => null }))
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

beforeEach(() => {
  useWorkflowStore.setState({ activeTab: 'runs', toasts: [] })
  for (const handler of Object.values(handlers)) handler.mockClear()
})

function renderPanel(runNodes: RunNode[]) {
  const props: Parameters<typeof RunsPanel>[0] = {
    ...handlers,
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
    fireEvent.click(screen.getByRole('button', { name: 'View timeline' }))
    expect(useWorkflowStore.getState().activeTab).toBe('reasoning')
  })

  it('delegates timeline navigation when hosted by the Runs workspace', () => {
    const onViewTimeline = vi.fn()
    render(
      <RunsPanel
        {...handlers}
        activeRunId="run-1"
        workflows={[]}
        runs={[{ id: 'run-1', status: 'succeeded' }]}
        runNodes={[]}
        usage={{}}
        onViewTimeline={onViewTimeline}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'View timeline' }))

    expect(onViewTimeline).toHaveBeenCalledTimes(1)
    expect(useWorkflowStore.getState().activeTab).toBe('runs')
  })

  it('labels approval and timer waits with actionable copy and timing', () => {
    render(
      <RunsPanel
        {...handlers}
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
