import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { parseRoute } from '../lib/route'
import { useWorkflowStore } from '../store'
import { RecoveryDeltaCard } from './RecoveryDeltaCard'

vi.mock('../api', () => {
  const module = ({
  api: vi.fn(),
})
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

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
  priorVersion: { version: 1, versionId: 'v-before' },
  ...overrides,
})

describe('<RecoveryDeltaCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({
      currentWorkflowId: 'wf-1', workflowRevision: 0,
      session: null,
      userId: 'dev-user',
      orgId: 'default',
      identityContext: {
        identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' },
        profile: { name: null, email: null },
        organizations: [{
          id: 'default', name: 'Default', plan: null, role: 'editor', roleBase: 'editor',
          permissions: ['workflows.read', 'workflows.write'], usable: true, developmentFallback: false, isOwner: false,
        }],
        invitations: [],
        currentOrganizationId: 'default',
        selectionRequired: false,
        needsOrganization: false,
        truncated: false,
        invitationsTruncated: false,
      },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the run counter and same-failure pill (gathering state) when hasEnoughData is false', async () => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: false,
      after: { score: 80, status: 'healthy', signals: baseSignals({ totalRuns: 3 }) },
      recentRunsAgainstAfter: { totalRuns: 3, succeeded: 2, failed: 1, running: 0 },
      sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'HTTP 500 on http node' },
    }))

    render(<RecoveryDeltaCard {...baseProps} />)

    await waitFor(() => screen.getByTestId('recovery-delta-counter'))
    expect(screen.getByText(/Runs from v2: 3/i)).toBeInTheDocument()
    expect(screen.getByText('2✓ 1✗')).toBeInTheDocument()
    expect(screen.getByText(/Same failure: 0 observed/i)).toBeInTheDocument()
    expect(screen.getByText(/3 of 5 completed runs/i)).toBeInTheDocument()
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

  it.each([
    { score: 5, latency: -50, cost: -.1, health: 'Health improved 5 points', speed: '50% faster', spend: '$0.100 cheaper per run', tone: 'success' },
    { score: -5, latency: 100, cost: .2, health: 'Health dropped 5 points', speed: '100% slower', spend: '$0.200 more per run', tone: 'danger' },
    { score: 0, latency: 0, cost: 0, health: 'Health unchanged', speed: '≈ same speed', spend: '≈ same cost', tone: 'neutral' },
  ])('preserves all three metric directions: $tone', async ({ score, latency, cost, health, speed, spend, tone }) => {
    vi.mocked(api).mockResolvedValueOnce(baseDelta({
      hasEnoughData: true,
      before: { score: 80, status: 'healthy', signals: baseSignals({ totalRuns: 5, p95LatencyMs: 100, totalCostUsd: 1 }) },
      after: { score: 80 + score, status: 'healthy', signals: baseSignals({ totalRuns: 5, p95LatencyMs: 100 + latency, totalCostUsd: (0.2 + cost) * 5 }) },
      delta: { score, p95LatencyMs: latency, costPerRunUsd: cost },
    }))
    render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByText(health)
    for (const sentence of [health, speed, spend]) {
      expect(screen.getByText(sentence).parentElement?.className).toContain(`we-recovery-delta-pill--${tone}`)
    }
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
      priorVersion: { version: 1, versionId: 'v-before' },
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
    const versionsResponse = [
      { workflowId: 'wf-1', createdAt: null, id: 'v-after', version: 2, dagJson: { dslVersion: '1.0', nodes: [], edges: [] } },
      { workflowId: 'wf-1', createdAt: null, id: 'v-before', version: 1, dagJson: { dslVersion: '1.0', nodes: [], edges: [] } },
    ]
    // The card pins each version with its own exact-version read.
    vi.mocked(api).mockResolvedValueOnce([versionsResponse[0]]).mockResolvedValueOnce([versionsResponse[1]])

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
      priorVersion: { version: 1, versionId: 'v-before' },
    }))
    useWorkflowStore.setState((state) => ({
      identityContext: state.identityContext
        ? {
            ...state.identityContext,
            organizations: state.identityContext.organizations.map((organization) => ({
              ...organization,
              role: 'billing-admin',
              roleBase: 'admin',
              permissions: ['workflows.read'],
            })),
          }
        : null,
    }))

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

    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBe(1))
    await act(async () => {
      useWorkflowStore.getState().bumpPlatformVersion()
    })
    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBe(2))
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
  const regression = () => baseDelta({ hasEnoughData: true,
    delta: { score: -8, p95LatencyMs: null, costPerRunUsd: null },
    before: { score: 81, status: 'healthy', signals: baseSignals({ totalRuns: 8 }) },
    after: { score: 73, status: 'warn', signals: baseSignals({ totalRuns: 5 }) },
    priorVersion: { version: 1, versionId: 'v-before' },
  })
  const versionRows = (path: string) => [{ workflowId: 'wf-1', createdAt: null,
    id: path.includes('version=2') ? 'v-after' : 'v-before',
    version: path.includes('version=2') ? 2 : 1,
    dagJson: { id: 'wf-1', nodes: [], edges: [] },
  }]
  const pending = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }

  it.each(['orgId', 'userId'] as const)('replaces old health immediately when %s changes', async key => {
    const next = pending<unknown>()
    vi.mocked(api).mockResolvedValueOnce(regression()).mockReturnValue(next.promise)
    render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByText(/Health dropped 8 points/i)
    act(() => useWorkflowStore.setState({ [key]: 'other' }))
    expect(screen.queryByText(/Health dropped 8 points/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Roll back to/ })).not.toBeInTheDocument()
    expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
  })

  it('clears old health on workflow/version prop changes', async () => {
    vi.mocked(api).mockResolvedValueOnce(regression()).mockReturnValue(new Promise(() => {}))
    const view = render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByText(/Health dropped 8 points/i)
    view.rerender(<RecoveryDeltaCard {...baseProps} workflowId="wf-2" afterVersion={3} />)
    expect(screen.queryByText(/Health dropped 8 points/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Roll back to/ })).not.toBeInTheDocument()
  })

  it.each(['actor', 'organization', 'workflow', 'edit', 'permission', 'refresh', 'unmount', 'batched-actor-return'])('discards late rollback versions after %s', async change => {
    const versions = pending<undefined>()
    vi.mocked(api).mockImplementation((path) => path.startsWith('/workflows/health/delta')
      ? Promise.resolve(regression()) : versions.promise.then(() => versionRows(path)))
    const view = render(<RecoveryDeltaCard {...baseProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Roll back to v1/ }))
    if (change === 'unmount') view.unmount()
    else await act(async () => {
      if (change === 'actor' || change === 'batched-actor-return') useWorkflowStore.setState({ userId: 'other' })
      if (change === 'batched-actor-return') useWorkflowStore.setState({ userId: 'dev-user' })
      if (change === 'organization') useWorkflowStore.setState({ orgId: 'other' })
      if (change === 'workflow') useWorkflowStore.setState({ currentWorkflowId: 'wf-2' })
      if (change === 'edit') useWorkflowStore.setState({ workflowRevision: 1 })
      if (change === 'permission') useWorkflowStore.setState({ identityContext: null })
      if (change === 'refresh') useWorkflowStore.getState().bumpPlatformVersion()
    })
    if (change === 'refresh') await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/workflows/health/delta'))).toHaveLength(2))
    await act(async () => { versions.resolve(undefined); await versions.promise })
    expect(screen.queryByTestId('rollback-dialog')).not.toBeInTheDocument()
    for (const [,options] of vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/workflows/versions'))) expect(options?.signal?.aborted).toBe(true)
  })

  it('keeps a useful rollback error when an exact-version read rejects without a message', async () => {
    vi.mocked(api).mockResolvedValueOnce(regression()).mockRejectedValue(undefined)
    render(<RecoveryDeltaCard {...baseProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Roll back to v1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load both versions for rollback.')
    expect(screen.queryByTestId('rollback-dialog')).not.toBeInTheDocument()
  })

  it('binds rollback target to the immutable prior version id from health evidence', async () => {
    vi.mocked(api).mockImplementation(path => Promise.resolve(path.startsWith('/workflows/health/delta')
      ? regression() : versionRows(path).map(row => ({ ...row, id: 'unrelated-id' }))))
    render(<RecoveryDeltaCard {...baseProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Roll back to v1/ }))
    await screen.findByRole('alert')
    expect(screen.queryByTestId('rollback-dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['foreign workflow', { workflowId: 'other' }], ['foreign cutoff', { afterVersion: 99 }],
    ['negative count', { recentRunsAgainstAfter: { totalRuns: -1, succeeded: 0, failed: 0, running: 0 } }],
    ['invalid sample gate', { hasEnoughData: true }],
    ['foreign signature', { sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'other' } }],
    ['invalid prior version', { priorVersion: { version: 2, versionId: 'v2' } }],
  ])('rejects %s without rendering health or rollback', async (_name, override) => {
    vi.mocked(api).mockResolvedValue({ ...baseDelta(), ...override as object })
    render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByRole('alert')
    expect(screen.queryByTestId('recovery-delta-counter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rollback-dialog')).not.toBeInTheDocument()
  })

  it('does not expose the captured before snapshot after an actor change', () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}))
    render(<RecoveryDeltaCard {...baseProps} preSaveBeforeSnapshot={{ score: 84, status: 'healthy', signals: baseSignals() }} />)
    expect(screen.getByText(/Health 84/)).toBeInTheDocument()
    act(() => useWorkflowStore.setState({ userId: 'other' }))
    expect(screen.queryByText(/Health 84/)).not.toBeInTheDocument()
  })

  it('drops evidence and stops reading when workflow read permission is revoked', async () => {
    vi.mocked(api).mockResolvedValue(regression())
    render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByText(/Health dropped 8 points/i)
    act(() => useWorkflowStore.setState(state => ({ identityContext: state.identityContext && {
      ...state.identityContext, organizations: state.identityContext.organizations.map(org => ({ ...org, permissions: ['workflows.write'] })),
    } })))
    expect(screen.queryByTestId('recovery-delta-counter')).not.toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('does not claim the original failure stopped when no runs have completed', async () => {
    vi.mocked(api).mockResolvedValue(baseDelta({ after: { score: 80, status: 'healthy', signals: baseSignals() },
      recentRunsAgainstAfter: { totalRuns: 0, succeeded: 0, failed: 0, running: 0 } }))
    render(<RecoveryDeltaCard {...baseProps} />)
    const failure = await screen.findByTestId('recovery-delta-same-failure')
    expect(failure).not.toHaveTextContent('no longer happening')
    expect(failure).not.toHaveClass('we-recovery-delta-pill--success')
    expect(failure).toHaveTextContent(/continue monitoring/i)
  })
  it('uses completed health samples, not running jobs, for the comparison floor', async () => {
    vi.mocked(api).mockResolvedValue(baseDelta({ recentRunsAgainstAfter: { totalRuns: 6, succeeded: 1, failed: 0, running: 5 } }))
    render(<RecoveryDeltaCard {...baseProps} />)
    await screen.findByTestId('recovery-delta-counter')
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1')
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', '5')
  })

  it('links recurring failure evidence through the actual queue route', async () => {
    vi.mocked(api).mockResolvedValue(baseDelta({ sameFailureSinceApply: {
      count: 1, sampleDeadLetterIds: ['failure / one'], priorSignature: baseProps.priorFailureSignature,
    } }))
    render(<RecoveryDeltaCard {...baseProps} />)
    const link = await screen.findByRole('link', { name: /View DLQ/i })
    expect(parseRoute(link.getAttribute('href')!)).toEqual({ tab: 'runs', deadLetterId: 'failure / one' })
  })

})
