/**
 * Regression coverage for the run sheet's tabs.
 *
 * The heavy child projections are mocked so these tests own only view
 * selection, run-identity reset, counts, and full-view handoffs.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RunWorkspace, type RunWorkspaceProps } from './RunWorkspace'

vi.mock('./RunsPanel', () => ({
  RunExplainChat: ({ runId }: { runId: string }) => <textarea data-testid="ask-projection" defaultValue={runId} />,
  RunsPanel: ({ renderSheet }: { renderSheet: (parts: { header: ReactNode; overview: ReactNode }) => ReactNode }) => (
    renderSheet({
      header: <div data-testid="sheet-header-projection" />,
      overview: <div data-testid="overview-projection" />,
    })
  ),
}))

vi.mock('./ReasoningPanel', () => ({
  ReasoningPanel: () => <div data-testid="events-projection">Events projection</div>,
}))

vi.mock('./RunStepTimeline', () => ({
  RunStepTimeline: ({ events }: { events: unknown[] }) => (
    <div data-testid="timeline-projection">{events.length}</div>
  ),
}))

vi.mock('../MultiAgentTimeline', () => ({
  MultiAgentTimeline: () => <div data-testid="agents-projection">Agents projection</div>,
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
}

function workspaceProps(overrides: Partial<RunWorkspaceProps> = {}): RunWorkspaceProps {
  return {
    ...handlers,
    runs: [],
    workflows: [],
    usage: {},
    runNodes: [{ nodeId: 'fetch', status: 'succeeded' }],
    runEvents: [
      { id: 'event-1', type: 'run.started' },
      { id: 'event-2', type: 'multi_agent.planned', nodeId: 'plan' },
      { id: 'event-3', type: 'multi_agent.completed', nodeId: 'plan' },
    ],
    activeRunId: 'run-1',
    ...overrides,
  }
}

describe('<RunWorkspace />', () => {
  beforeEach(() => {
    for (const handler of Object.values(handlers)) handler.mockClear()
  })

  it('starts on Overview and exposes counts through accessible tab names', () => {
    render(<RunWorkspace {...workspaceProps()} />)

    expect(screen.getByTestId('sheet-header-projection')).toBeInTheDocument()
    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Timeline, 2 steps' })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: 'Events, 3 events' })).toHaveTextContent('3')
    expect(screen.getByRole('tab', { name: 'Agents, 2 multi-agent events' })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: 'Ask' })).toBeInTheDocument()
  })

  it('keeps the sheet header on every tab and hands off the full views', async () => {
    render(<RunWorkspace {...workspaceProps()} />)

    expect(screen.queryByTestId('run-workspace-full-view')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('run-workspace-tab-timeline'))
    expect(await screen.findByTestId('timeline-projection')).toHaveTextContent('3')
    expect(screen.queryByTestId('overview-projection')).not.toBeInTheDocument()
    expect(screen.getByTestId('sheet-header-projection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open full timeline' }))
    expect(handlers.onOpenFullView).toHaveBeenLastCalledWith('reasoning')

    fireEvent.click(screen.getByTestId('run-workspace-tab-events'))
    expect(await screen.findByTestId('events-projection')).toBeInTheDocument()
    expect(screen.queryByTestId('timeline-projection')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('run-workspace-tab-agents'))
    expect(await screen.findByTestId('agents-projection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open full agent view' }))
    expect(handlers.onOpenFullView).toHaveBeenLastCalledWith('multiAgent')

    fireEvent.click(screen.getByTestId('run-workspace-tab-ask'))
    expect(await screen.findByTestId('ask-projection')).toBeVisible()
    expect(screen.queryByTestId('run-workspace-full-view')).not.toBeInTheDocument()
  })

  it('keeps the Ask conversation across tabs and drops it with the run', async () => {
    const props = workspaceProps()
    const { rerender } = render(<RunWorkspace {...props} />)
    expect(screen.queryByTestId('ask-projection')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('run-workspace-tab-ask'))
    const conversation = await screen.findByTestId('ask-projection')

    fireEvent.click(screen.getByTestId('run-workspace-tab-events'))
    expect(await screen.findByTestId('events-projection')).toBeInTheDocument()
    expect(screen.getByTestId('ask-projection')).toBe(conversation)
    expect(conversation).not.toBeVisible()

    rerender(<RunWorkspace {...props} activeRunId="run-2" />)
    await waitFor(() => expect(screen.queryByTestId('ask-projection')).not.toBeInTheDocument())
  })

  it('resets synchronously to Overview when the active run identity changes', async () => {
    const props = workspaceProps()
    const { rerender } = render(<RunWorkspace {...props} />)
    fireEvent.click(screen.getByTestId('run-workspace-tab-timeline'))
    expect(await screen.findByTestId('timeline-projection')).toBeInTheDocument()

    rerender(<RunWorkspace {...props} activeRunId="run-2" />)

    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.queryByTestId('timeline-projection')).not.toBeInTheDocument())
  })

  it('disables run-bound views when no run is active', () => {
    render(<RunWorkspace {...workspaceProps({ activeRunId: null })} />)

    for (const tab of ['timeline', 'events', 'agents', 'ask']) {
      expect(screen.getByTestId(`run-workspace-tab-${tab}`)).toBeDisabled()
    }
    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
  })
})
