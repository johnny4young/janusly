/**
 * Regression coverage for the Runs inspection workspace.
 *
 * The heavy child projections are mocked so these tests own only view
 * selection, run-identity reset, counts, and full-view handoffs.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RunWorkspace, type RunWorkspaceProps } from './RunWorkspace'

vi.mock('./RunsPanel', () => ({
  RunsPanel: ({ onViewTimeline }: { onViewTimeline?: () => void }) => (
    <div data-testid="overview-projection">
      <button type="button" onClick={onViewTimeline}>View inline timeline</button>
    </div>
  ),
}))

vi.mock('./ReasoningPanel', () => ({
  ReasoningPanel: () => <div data-testid="timeline-projection">Timeline projection</div>,
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
    runNodes: [],
    runEvents: [
      { id: 'event-1', type: 'run.started' },
      { id: 'event-2', type: 'multi_agent.planned' },
      { id: 'event-3', type: 'multi_agent.completed' },
    ],
    activeRunId: 'run-1',
    ...overrides,
  }
}

describe('<RunWorkspace />', () => {
  beforeEach(() => {
    for (const handler of Object.values(handlers)) handler.mockClear()
  })

  it('starts on Overview and exposes event counts through accessible tab names', () => {
    render(<RunWorkspace {...workspaceProps()} />)

    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Timeline, 3 events' })).toHaveTextContent('3')
    expect(screen.getByRole('tab', { name: 'Agents, 2 multi-agent events' })).toHaveTextContent('2')
  })

  it('keeps the overview timeline action in-context and preserves explicit full views', async () => {
    render(<RunWorkspace {...workspaceProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'View inline timeline' }))
    expect(await screen.findByTestId('timeline-projection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open full timeline' }))
    expect(handlers.onOpenFullView).toHaveBeenCalledWith('reasoning')

    fireEvent.click(screen.getByRole('tab', { name: 'Agents, 2 multi-agent events' }))
    expect(await screen.findByTestId('agents-projection')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open full agent view' }))
    expect(handlers.onOpenFullView).toHaveBeenLastCalledWith('multiAgent')
  })

  it('resets synchronously to Overview when the active run identity changes', async () => {
    const props = workspaceProps()
    const { rerender } = render(<RunWorkspace {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline, 3 events' }))
    expect(await screen.findByTestId('timeline-projection')).toBeInTheDocument()

    rerender(<RunWorkspace {...props} activeRunId="run-2" />)

    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.queryByTestId('timeline-projection')).not.toBeInTheDocument())
  })

  it('disables run-bound views when no run is active', () => {
    render(<RunWorkspace {...workspaceProps({ activeRunId: null })} />)

    expect(screen.getByRole('tab', { name: 'Timeline, 3 events' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Agents, 2 multi-agent events' })).toBeDisabled()
    expect(screen.getByTestId('overview-projection')).toBeInTheDocument()
  })
})
