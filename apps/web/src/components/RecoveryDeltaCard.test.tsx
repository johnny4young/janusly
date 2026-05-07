import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryDeltaCard } from './RecoveryDeltaCard'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

// RollbackConfirmDialog imports the real one which calls the api wrapper;
// stub it out so we just assert it mounted with the expected props.
vi.mock('./RollbackConfirmDialog', () => ({
  RollbackConfirmDialog: ({ workflowId, current, target }: { workflowId: string; current: { version: number }; target: { version: number } }) => (
    <div data-testid="rollback-dialog">
      Rollback {workflowId} from v{current.version} to v{target.version}
    </div>
  ),
}))

const baseProps = {
  workflowId: 'wf-1',
  afterVersion: 2,
  priorFailureSignature: 'HTTP 500 on http node',
  preSaveBeforeSnapshot: null,
}

const editorMember = { id: 'member-1', orgId: 'default', userId: 'dev-user', role: 'editor' as const }

const baseSignals = (overrides: Partial<{ p95LatencyMs: number | null; totalRuns: number; totalCostUsd: number }> = {}) => ({
  p95LatencyMs: null as number | null,
  totalRuns: 0,
  totalCostUsd: 0,
  ...overrides,
})

const baseDelta = (overrides: Partial<{
  hasEnoughData: boolean
  delta: { score: number; p95LatencyMs: number | null; costPerRunUsd: number | null } | null
  before: { score: number; status: string; signals: ReturnType<typeof baseSignals> }
  after: { score: number; status: string; signals: ReturnType<typeof baseSignals> }
  recentRunsAgainstAfter: { totalRuns: number; succeeded: number; failed: number; running: number }
  sameFailureSinceApply: { count: number; sampleDeadLetterIds: string[]; priorSignature: string } | null
  priorVersion: { version: number; versionId: string } | null
}> = {}) => ({
  workflowId: 'wf-1',
  afterVersion: 2,
  windowDays: 1,
  hasEnoughData: false,
  before: { score: 80, status: 'healthy', signals: baseSignals() },
  after: { score: 80, status: 'healthy', signals: baseSignals({ totalRuns: 1 }) },
  delta: null,
  recentRunsAgainstAfter: { totalRuns: 1, succeeded: 1, failed: 0, running: 0 },
  sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'HTTP 500 on http node' },
  priorVersion: { version: 1, versionId: 'v0' },
  ...overrides,
})

describe('<RecoveryDeltaCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ platformVersion: 0, session: null, userId: 'dev-user', orgId: 'default' })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the run counter and same-failure pill (gathering state) when hasEnoughData is false', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: false,
      recentRunsAgainstAfter: { totalRuns: 3, succeeded: 2, failed: 1, running: 0 },
      sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'HTTP 500 on http node' },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByTestId('recovery-delta-counter'))
    expect(screen.getByText(/Runs against v2: 3/i)).toBeInTheDocument()
    expect(screen.getByText('2✓ 1✗')).toBeInTheDocument()
    expect(screen.getByText(/Same failure since Apply: ✓ 0 occurrences/i)).toBeInTheDocument()
    expect(screen.getByText(/3 of 5 runs collected/i)).toBeInTheDocument()
    // Health/p95/cost pills do NOT render in gathering state.
    expect(screen.queryByText(/Health improved/i)).not.toBeInTheDocument()
  })

  it('renders all pills with plain-language sentences in the ready state', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: 4, p95LatencyMs: -1900, costPerRunUsd: -0.004 },
      before: { score: 81, status: 'healthy', signals: baseSignals({ p95LatencyMs: 5000, totalRuns: 8, totalCostUsd: 0.096 }) },
      after: { score: 85, status: 'healthy', signals: baseSignals({ p95LatencyMs: 3100, totalRuns: 6, totalCostUsd: 0.048 }) },
      recentRunsAgainstAfter: { totalRuns: 6, succeeded: 6, failed: 0, running: 0 },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health improved 4 points/i))
    expect(screen.getByText(/38% faster/i)).toBeInTheDocument()
    expect(screen.getByText(/cheaper per run/i)).toBeInTheDocument()
    // before → after numbers also surface visibly.
    expect(screen.getByText(/81/)).toBeInTheDocument()
    expect(screen.getByText(/85/)).toBeInTheDocument()
  })

  it('hides the cost pill when both sides have zero spend', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: 2, p95LatencyMs: null, costPerRunUsd: null },
      before: { score: 80, status: 'healthy', signals: baseSignals({ totalRuns: 8, totalCostUsd: 0 }) },
      after: { score: 82, status: 'healthy', signals: baseSignals({ totalRuns: 6, totalCostUsd: 0 }) },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health improved 2 points/i))
    expect(screen.queryByText(/per run/i)).not.toBeInTheDocument()
  })

  it('renders danger-tinted same-failure pill with View DLQ link when count > 0', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      sameFailureSinceApply: {
        count: 2,
        sampleDeadLetterIds: ['dlq-new-1', 'dlq-new-2'],
        priorSignature: 'HTTP 500 on http node',
      },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Same failure: 2 occurrences/i))
    const viewLink = screen.getByText(/View DLQ/i) as HTMLAnchorElement
    expect(viewLink).toBeInTheDocument()
    expect(viewLink.getAttribute('href')).toContain('dlq-new-1')
  })

  it('renders the regression rollback button when delta.score <= -3 and priorVersion is set', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: -7, p95LatencyMs: null, costPerRunUsd: null },
      before: { score: 85, status: 'healthy', signals: baseSignals({ totalRuns: 10 }) },
      after: { score: 78, status: 'warn', signals: baseSignals({ totalRuns: 5 }) },
      priorVersion: { version: 1, versionId: 'v0' },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health dropped 7 points/i))
    expect(screen.getByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('omits the regression rollback button when priorVersion is null', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: -7, p95LatencyMs: null, costPerRunUsd: null },
      after: { score: 78, status: 'warn', signals: baseSignals({ totalRuns: 5 }) },
      before: { score: 85, status: 'healthy', signals: baseSignals({ totalRuns: 10 }) },
      priorVersion: null,
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health dropped 7 points/i))
    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it('omits the regression rollback button when delta is below the regression threshold (delta = -1)', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: -1, p95LatencyMs: null, costPerRunUsd: null },
      after: { score: 80, status: 'healthy', signals: baseSignals({ totalRuns: 5 }) },
      before: { score: 81, status: 'healthy', signals: baseSignals({ totalRuns: 8 }) },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health dropped 1 point/i))
    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it('clicking Roll back fetches both versions and mounts RollbackConfirmDialog', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: -8, p95LatencyMs: null, costPerRunUsd: null },
      after: { score: 73, status: 'warn', signals: baseSignals({ totalRuns: 5 }) },
      before: { score: 81, status: 'healthy', signals: baseSignals({ totalRuns: 8 }) },
    }))
    vi.mocked(api).mockResolvedValueOnce([editorMember])
    const versionsResponse = [
      { id: 'v-after', version: 2, dagJson: { dslVersion: '1.0', nodes: [], edges: [] } },
      { id: 'v-before', version: 1, dagJson: { dslVersion: '1.0', nodes: [], edges: [] } },
    ]
    vi.mocked(api).mockResolvedValueOnce(versionsResponse)

    render(<RecoveryDeltaCard {...baseProps} />)
    await waitFor(() => screen.getByRole('button', { name: /Roll back to v1/i }))
    fireEvent.click(screen.getByRole('button', { name: /Roll back to v1/i }))

    await waitFor(() => screen.getByTestId('rollback-dialog'))
    expect(screen.getByText(/Rollback wf-1 from v2 to v1/i)).toBeInTheDocument()
  })

  it('hides the regression rollback button for viewers', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      delta: { score: -8, p95LatencyMs: null, costPerRunUsd: null },
      after: { score: 73, status: 'warn', signals: baseSignals({ totalRuns: 5 }) },
      before: { score: 81, status: 'healthy', signals: baseSignals({ totalRuns: 8 }) },
      priorVersion: { version: 1, versionId: 'v0' },
    }))
    vi.mocked(api).mockResolvedValueOnce([{ ...editorMember, role: 'viewer' }])

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Health dropped 8 points/i))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
    })
  })

  it('renders the error state with a Retry button when the fetch fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Boom'))
    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByText(/Couldn't load delta/i))
    expect(screen.getByText(/Boom/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('refetches when platformVersion bumps in the store', async () => {
    vi.mocked(api).mockResolvedValue(baseDelta())

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBe(2))
    await act(async () => {
      useWorkflowStore.getState().bumpPlatformVersion()
    })
    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBe(4))
  })

  it('renders the pre-fetched before-snapshot in the loading state', () => {
    vi.mocked(api).mockReturnValue(new Promise(() => { /* never resolves */ }))
    render(
      <RecoveryDeltaCard
        {...baseProps}
        preSaveBeforeSnapshot={{
          score: 84,
          status: 'healthy',
          signals: { p95LatencyMs: 5000, totalRuns: 12, totalCostUsd: 0.024 },
        }}
      />,
    )
    expect(screen.getByText(/Before Apply/i)).toBeInTheDocument()
    expect(screen.getByText(/Health 84/)).toBeInTheDocument()
  })
})
