import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { OperationsPage, requestOperationsSection } from './OperationsPage'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

// Each card under the sub-tabs self-fetches on mount. We stub the cards
// to (a) keep this test focused on the page shell, and (b) prove which
// sub-tab is mounted at any moment via a unique DOM marker per card.
vi.mock('./FailureClustersCard', () => ({
  FailureClustersCard: () => <section data-testid="stub-FailureClustersCard">FailureClusters</section>,
}))
vi.mock('./BudgetSettingsPanel', () => ({
  BudgetSettingsPanel: () => <section data-testid="stub-BudgetSettingsPanel">Budget</section>,
}))
vi.mock('./AiGuidanceSettingsPanel', () => ({
  AiGuidanceSettingsPanel: () => <section data-testid="stub-AiGuidanceSettingsPanel">Guidance</section>,
}))
vi.mock('./AuthPolicySettingsPanel', () => ({
  AuthPolicySettingsPanel: () => <section data-testid="stub-AuthPolicySettingsPanel">AuthPolicy</section>,
}))
vi.mock('./ScimDirectorySettingsPanel', () => ({
  ScimDirectorySettingsPanel: () => <section data-testid="stub-ScimDirectorySettingsPanel">Scim</section>,
}))
vi.mock('./PermissionGrantsPanel', () => ({
  PermissionGrantsPanel: () => <section data-testid="stub-PermissionGrantsPanel">Permissions</section>,
}))
vi.mock('./CredentialHealthCard', () => ({
  CredentialHealthCard: () => <section data-testid="stub-CredentialHealthCard">CredHealth</section>,
}))
vi.mock('./AlertPoliciesPanel', () => ({
  AlertPoliciesPanel: () => <section data-testid="stub-AlertPoliciesPanel">AlertPolicies</section>,
}))
vi.mock('./RecentAlertsCard', () => ({
  RecentAlertsCard: () => <section data-testid="stub-RecentAlertsCard">RecentAlerts</section>,
}))
vi.mock('./McpConnectionsPanel', () => ({
  McpConnectionsPanel: () => <section data-testid="stub-McpConnectionsPanel">Mcp</section>,
}))

const initialState = useWorkflowStore.getState()
const STORAGE_KEY = 'janusly:operations:section'
const clearQueue = { waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }

const healthyMetrics = {
  windowDays: 30,
  terminalRuns: 12,
  successRate: { value: 95, display: '95.0%', severity: 'healthy', rationale: 'All good.' },
  mttr: { value: 90_000, display: '1m 30s', severity: 'healthy', rationale: '' },
  p95Latency: { value: 4_000, display: '4.0s', severity: 'healthy', rationale: '' },
  approvalsPending: { value: 0, display: '0', severity: 'neutral', rationale: '' },
  replayRate: { value: 90, display: '90.0%', severity: 'healthy', rationale: '' },
  costThisWindow: {
    value: 0,
    display: '$0',
    severity: 'neutral',
    rationale: '',
    providers: [],
    cache: { inputTokens: 0, readTokens: 0, creationTokens: 0, readSharePercent: null },
  },
}

function stubApiByPath(handlers: Record<string, unknown>) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    for (const key of Object.keys(handlers)) {
      if (path === key || path.startsWith(`${key}?`)) {
        const value = handlers[key]
        if (value instanceof Promise) return value
        return value as unknown
      }
    }
    if (path === '/system/queue') return clearQueue
    return null
  })
}

describe('<OperationsPage />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, budgetBlocked: null }, true)
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults to the Overview sub-tab when localStorage is empty', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    expect(screen.getByTestId('operations-rail-tab-overview')).toHaveAttribute('aria-current', 'page')
    // Reliability cards are NOT mounted — proves lazy-mount.
    expect(screen.queryByTestId('stub-BudgetSettingsPanel')).toBeNull()
    expect(screen.queryByTestId('stub-AlertPoliciesPanel')).toBeNull()
  })

  it('shows prompt-cache efficiency and per-provider cache tokens', async () => {
    stubApiByPath({
      '/recovery/metrics': {
        ...healthyMetrics,
        costThisWindow: {
          ...healthyMetrics.costThisWindow,
          providers: [
            {
              provider: 'Anthropic',
              model: 'claude-haiku-4-5',
              usd: 1.25,
              tokens: 20_000,
              inputTokens: 16_000,
              cachedInputTokens: 8_000,
              cacheCreationInputTokens: 2_000,
              calls: 4,
            },
            {
              provider: '__other__',
              model: '__other__',
              usd: 0.25,
              tokens: 100,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              calls: 3,
              aggregated: true,
            },
          ],
          cache: {
            inputTokens: 16_000,
            readTokens: 8_000,
            creationTokens: 2_000,
            readSharePercent: 50,
          },
        },
      },
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    const summary = await screen.findByLabelText('Prompt cache efficiency')
    expect(summary).toHaveTextContent('Input served from cache50%')
    expect(summary).toHaveTextContent('Cache-read tokens8,000')
    expect(summary).toHaveTextContent('Cache-created tokens2,000')
    expect(screen.getByRole('columnheader', { name: 'Cache read' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Cache created' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Cost breakdown table' })).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByText('8,000')).toHaveLength(2)
    const aggregateRow = screen.getByText('Other providers and models').closest('tr')
    expect(aggregateRow).not.toBeNull()
    expect(within(aggregateRow as HTMLElement).getByText('—')).toBeInTheDocument()
  })

  it('mounts only the active sub-tab cards when the operator clicks Reliability', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    fireEvent.click(screen.getByTestId('operations-rail-tab-reliability'))

    expect(screen.getByTestId('stub-AlertPoliciesPanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-RecentAlertsCard')).toBeInTheDocument()
    expect(screen.getByTestId('stub-BudgetSettingsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-AiGuidanceSettingsPanel')).toBeInTheDocument()
    // Overview cards are gone.
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
    // Access / Integrations cards are not mounted either.
    expect(screen.queryByTestId('stub-AuthPolicySettingsPanel')).toBeNull()
    expect(screen.queryByTestId('stub-CredentialHealthCard')).toBeNull()
  })

  it('persists the selected section to localStorage on change', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    fireEvent.click(screen.getByTestId('operations-rail-tab-access'))

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('access')
    })
  })

  it('hydrates from localStorage on mount', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'integrations')
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-CredentialHealthCard')
    expect(screen.getByTestId('stub-McpConnectionsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('operations-rail-tab-integrations')).toHaveAttribute('aria-current', 'page')
    // Overview cards are NOT mounted because we hydrated to integrations.
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
  })

  it('honors external section requests while already mounted', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    act(() => requestOperationsSection('reliability'))

    await screen.findByTestId('stub-BudgetSettingsPanel')
    expect(screen.getByTestId('operations-rail-tab-reliability')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
  })

  it('falls back to overview when localStorage holds an unknown section', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'bogus-tab')
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    expect(screen.getByTestId('operations-rail-tab-overview')).toHaveAttribute('aria-current', 'page')
  })

  it('lights the Reliability dot when the rate-limiter is degraded', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': {
        ok: true,
        rateLimiter: {
          healthy: false,
          degradedBuckets: [
            { bucket: 'ai', errorCount: 4, firstObservedAt: 'x', lastObservedAt: 'x' },
          ],
        },
      },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    await waitFor(() => {
      expect(screen.getByTestId('operations-rail-dot-reliability')).toBeInTheDocument()
    })
    expect(screen.getByTestId('operations-rail-dot-reliability')).toHaveAttribute('data-severity', 'warning')
    // No dot on overview (metrics are healthy), no dot on access/integrations
    // (those sub-tabs have no page-level signal source — see the rail's dotKind map).
    expect(screen.queryByTestId('operations-rail-dot-overview')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-access')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-integrations')).toBeNull()
  })

  it('shows admin queue pressure and lights Reliability only above the threshold', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: { degraded: true } },
      '/system/queue': { waiting: 3, active: 2, oldestWaitingSeconds: 91, warnSeconds: 60 },
    })

    render(<OperationsPage />)

    const chip = await screen.findByTestId('queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'delayed')
    expect(chip).toHaveTextContent('Queue delayed')
    expect(chip).toHaveTextContent('Jobs are still processing')
    expect(screen.getByTestId('operations-rail-dot-reliability')).toHaveAttribute('data-severity', 'warning')
  })

  it('treats an unavailable admin queue snapshot as unknown, not empty', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: null },
      '/system/queue': null,
    })

    render(<OperationsPage />)

    const chip = await screen.findByTestId('queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'unavailable')
    expect(chip).toHaveTextContent('Queue status unavailable — Redis could not be read')
    expect(screen.getByTestId('operations-rail-dot-reliability')).toHaveAttribute('data-severity', 'warning')
  })

  it('does not diagnose an initial queue request failure as a Redis failure', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') return { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }
      if (path === '/system/queue') throw new Error('network offline')
      return null
    })

    render(<OperationsPage />)

    const chip = await screen.findByTestId('queue-lag-chip')
    expect(chip).toHaveTextContent('Queue status unavailable — request failed')
    expect(chip).not.toHaveTextContent('Redis could not be read')
  })

  it('hides admin queue telemetry and stops denied polling after a 403', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let queueCalls = 0
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') return { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }
      if (path === '/system/queue') {
        queueCalls += 1
        throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      }
      return null
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    await waitFor(() => expect(queueCalls).toBe(1))
    expect(screen.queryByTestId('queue-lag-chip')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-reliability')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(40_000)
      await Promise.resolve()
    })
    expect(queueCalls).toBe(1)
  })

  it('keeps the last rate-limiter snapshot visible when a later health poll fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const healthResponses: Array<unknown> = [
      { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
      new Error('health offline'),
    ]
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') {
        const next = healthResponses.shift()
        if (next instanceof Error) throw next
        return next
      }
      return null
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    const rateChip = (await screen.findByText(/Rate limiter healthy/i)).closest('[role="status"]')
    expect(rateChip).not.toBeNull()
    expect(within(rateChip as HTMLElement).getByText(/Checked/i)).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })

    expect(within(rateChip as HTMLElement).getByText(/Rate limiter healthy/i)).toBeInTheDocument()
    expect(within(rateChip as HTMLElement).getByText(/Checked/i)).toBeInTheDocument()
  })

  it('escalates the Reliability dot to danger when a budget block is in store', async () => {
    useWorkflowStore.setState({
      ...initialState,
      platformVersion: 0,
      budgetBlocked: { monthlyUsdSpent: 12, monthlyUsdLimit: 10, exceededAt: 'org', policy: 'block' },
    }, true)
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('stub-FailureClustersCard')
    await waitFor(() => {
      expect(screen.getByTestId('operations-rail-dot-reliability')).toHaveAttribute('data-severity', 'danger')
    })
  })
})
