import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { changeAppLanguage } from '../i18n'
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
vi.mock('./MemoryGovernancePanel', () => ({
  MemoryGovernancePanel: () => <section data-testid="stub-MemoryGovernancePanel">Memory</section>,
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
vi.mock('./SlackInteractionsPanel', () => ({
  SlackInteractionsPanel: () => <section data-testid="stub-SlackInteractionsPanel">SlackInteractions</section>,
}))

const initialState = useWorkflowStore.getState()
const STORAGE_KEY = 'janusly:operations:section'
const clearQueue = { waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }

const healthyMetrics = {
  windowDays: 30,
  terminalRuns: 12,
  successRate: { value: 95, display: '95.0%', severity: 'healthy', rationale: 'All good.' },
  verifiedRecovery: {
    value: 45_000,
    display: '45.0s',
    severity: 'healthy',
    rationale: 'Production median.',
    rationaleCode: 'verified_recovery.summary',
  },
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

async function openInfrastructureSettings(): Promise<void> {
  await screen.findByTestId('settings-index-infrastructure')
  fireEvent.click(screen.getByTestId('operations-rail-tab-infrastructure'))
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

    await screen.findByTestId('settings-index-reliability')
    expect(screen.getByTestId('operations-rail-tab-overview')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Workspace settings' })).toBeInTheDocument()
    expect(screen.getByTestId('settings-index-integrations')).toBeInTheDocument()
    expect(screen.getByTestId('settings-index-ai')).toBeInTheDocument()
    expect(screen.getByTestId('settings-index-ai')).toHaveTextContent('Health unavailable')
    // Focused settings panels stay dormant until their area is opened.
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
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
    await screen.findByTestId('settings-index-usage')
    fireEvent.click(screen.getByTestId('operations-rail-tab-usage'))

    const summary = await screen.findByLabelText('Prompt cache efficiency')
    expect(summary).toHaveTextContent('Input served from cache50%')
    expect(summary).toHaveTextContent('Cache-read tokens8,000')
    expect(summary).toHaveTextContent('Cache-created tokens2,000')
    expect(screen.getByRole('columnheader', { name: 'Cache read' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Cache created' })).toBeInTheDocument()
    const costTable = screen.getByTestId('settings-usage-cost-table')
    expect(costTable).toHaveAccessibleName('Cost breakdown table')
    expect(costTable).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByText('8,000')).toHaveLength(2)
    const aggregateRow = screen.getByText('Other providers and models').closest('tr')
    expect(aggregateRow).not.toBeNull()
    expect(within(aggregateRow as HTMLElement).getByText('—')).toBeInTheDocument()

    await changeAppLanguage('es')
    expect(costTable).toHaveAccessibleName('Tabla de desglose de costo')
  })

  it('mounts only the active sub-tab cards when the operator clicks Reliability', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('settings-index-reliability')
    fireEvent.click(screen.getByTestId('operations-rail-tab-reliability'))

    expect(await screen.findByTestId('stub-AlertPoliciesPanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-RecentAlertsCard')).toBeInTheDocument()
    expect(screen.getByTestId('stub-FailureClustersCard')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-BudgetSettingsPanel')).toBeNull()
    expect(screen.queryByTestId('stub-AiGuidanceSettingsPanel')).toBeNull()
    // Access / Integrations cards are not mounted either.
    expect(screen.queryByTestId('stub-AuthPolicySettingsPanel')).toBeNull()
  })

  it('persists the selected section to localStorage on change', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('settings-index-reliability')
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

    expect(await screen.findByTestId('stub-McpConnectionsPanel')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-SlackInteractionsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('operations-rail-tab-integrations')).toHaveAttribute('aria-current', 'page')
    // Reliability panels are NOT mounted because we hydrated to integrations.
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
  })

  it('honors external section requests while already mounted', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('settings-index-reliability')
    act(() => requestOperationsSection('ai'))

    await screen.findByTestId('stub-BudgetSettingsPanel')
    expect(screen.getByTestId('stub-AiGuidanceSettingsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('operations-rail-tab-ai')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('stub-FailureClustersCard')).toBeNull()
  })

  it('falls back to overview when localStorage holds an unknown section', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'bogus-tab')
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    await screen.findByTestId('settings-index-reliability')
    expect(screen.getByTestId('operations-rail-tab-overview')).toHaveAttribute('aria-current', 'page')
  })

  it('lights the Infrastructure dot when the rate-limiter is degraded', async () => {
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

    await screen.findByTestId('settings-index-reliability')
    await waitFor(() => {
      expect(screen.getByTestId('operations-rail-dot-infrastructure')).toBeInTheDocument()
    })
    expect(screen.getByTestId('operations-rail-dot-infrastructure')).toHaveAttribute('data-severity', 'warning')
    // No dot on overview (metrics are healthy), no dot on access/integrations
    // (those sub-tabs have no page-level signal source — see the rail's dotKind map).
    expect(screen.queryByTestId('operations-rail-dot-overview')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-access')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-integrations')).toBeNull()
  })

  it('shows admin queue pressure and lights Infrastructure only above the threshold', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: { degraded: true } },
      '/system/queue': { waiting: 3, active: 2, oldestWaitingSeconds: 91, warnSeconds: 60 },
    })

    render(<OperationsPage />)

    await openInfrastructureSettings()
    const stream = screen.getByText('Live run connection').closest('.we-infrastructure-card__queue')
    expect(stream).not.toBeNull()
    expect(within(stream as HTMLElement).getByText('None')).toBeInTheDocument()
    const chip = await screen.findByTestId('queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'delayed')
    expect(chip).toHaveTextContent('Queue delayed')
    expect(chip).toHaveTextContent('Jobs are still processing')
    expect(screen.getByTestId('operations-rail-dot-infrastructure')).toHaveAttribute('data-severity', 'warning')
  })

  it('shows maintenance pressure independently from a clear workflow queue', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: { degraded: true } },
      '/system/queue': {
        waiting: 0,
        active: 1,
        oldestWaitingSeconds: null,
        warnSeconds: 60,
        maintenance: {
          waiting: 2,
          active: 0,
          oldestWaitingSeconds: 301,
          warnSeconds: 300,
        },
      },
    })

    render(<OperationsPage />)

    await openInfrastructureSettings()
    expect(await screen.findByTestId('queue-lag-chip')).toHaveAttribute('data-state', 'clear')
    const maintenance = screen.getByTestId('maintenance-queue-lag-chip')
    expect(maintenance).toHaveAttribute('data-state', 'delayed')
    expect(maintenance).toHaveTextContent('Maintenance delayed')
    expect(screen.getByTestId('operations-rail-dot-infrastructure')).toHaveAttribute('data-severity', 'warning')
  })

  it('attributes an explicit null maintenance snapshot to Redis, not transport', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: null },
      '/system/queue': {
        waiting: 0,
        active: 1,
        oldestWaitingSeconds: null,
        warnSeconds: 60,
        maintenance: null,
      },
    })

    render(<OperationsPage />)

    await openInfrastructureSettings()
    const maintenance = await screen.findByTestId('maintenance-queue-lag-chip')
    expect(maintenance).toHaveTextContent('Maintenance status unavailable — Redis could not be read')
    expect(maintenance).not.toHaveTextContent('request failed')
  })

  it('treats an unavailable admin queue snapshot as unknown, not empty', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: null },
      '/system/queue': null,
    })

    render(<OperationsPage />)

    await openInfrastructureSettings()
    const chip = await screen.findByTestId('queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'unavailable')
    expect(chip).toHaveTextContent('Queue status unavailable — Redis could not be read')
    expect(screen.getByTestId('operations-rail-dot-infrastructure')).toHaveAttribute('data-severity', 'warning')
  })

  it('does not diagnose an initial queue request failure as a Redis failure', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') return { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }
      if (path === '/system/queue') throw new Error('network offline')
      return null
    })

    render(<OperationsPage />)

    await openInfrastructureSettings()
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

    await openInfrastructureSettings()
    await waitFor(() => expect(queueCalls).toBe(1))
    expect(screen.queryByTestId('queue-lag-chip')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-infrastructure')).toBeNull()

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

    await openInfrastructureSettings()
    const rateCard = screen.getByText('Rate limiter').closest('.we-infrastructure-card__queue')
    expect(rateCard).not.toBeNull()
    expect(within(rateCard as HTMLElement).getByText('Healthy')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })

    expect(within(rateCard as HTMLElement).getByText('Healthy')).toBeInTheDocument()
  })

  it('escalates the AI dot to danger when a budget block is in store', async () => {
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

    await screen.findByTestId('settings-index-reliability')
    await waitFor(() => {
      expect(screen.getByTestId('operations-rail-dot-ai')).toHaveAttribute('data-severity', 'danger')
    })
  })

  it('searches configuration areas and routes direct settings pages', async () => {
    const onOpenTab = vi.fn()
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage connectionCount={3} onOpenTab={onOpenTab} />)

    const search = await screen.findByLabelText('Find provider, credential, member, alert, queue…')
    fireEvent.change(search, { target: { value: 'queue' } })
    expect(screen.getByTestId('settings-index-infrastructure')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-index-reliability')).toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
    expect(onOpenTab).toHaveBeenCalledWith('credentials')
  })

  it('keeps an area visible when any contained capability is granted', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage permissions={['recovery.read', 'mcp.connections.read']} />)

    expect(await screen.findByTestId('settings-index-integrations')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('settings-index-integrations'))
    expect(await screen.findByTestId('stub-McpConnectionsPanel')).toBeInTheDocument()
  })

  it('does not request recovery metrics for a settings-only permission scope', async () => {
    stubApiByPath({
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage permissions={['credentials.read']} />)

    expect(await screen.findByTestId('operations-rail-tab-integrations'))
      .toHaveAttribute('aria-current', 'page')
    expect(api).not.toHaveBeenCalledWith('/recovery/metrics')
    expect(screen.queryByText(/Recovery metrics are temporarily unavailable/)).toBeNull()
  })

  it('routes credential readers from Integrations to the canonical Connections inventory', async () => {
    const onOpenTab = vi.fn()
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(
      <OperationsPage
        permissions={['recovery.read', 'credentials.read']}
        onOpenTab={onOpenTab}
      />,
    )

    fireEvent.click(await screen.findByTestId('settings-index-integrations'))
    fireEvent.click(await screen.findByRole('button', { name: 'Connections' }))
    expect(onOpenTab).toHaveBeenCalledWith('credentials')
  })

  it('keeps write-only integration and recovery-governance sections reachable', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    const { rerender } = render(
      <OperationsPage permissions={['recovery.read', 'credentials.write']} />,
    )

    fireEvent.click(await screen.findByTestId('settings-index-integrations'))
    expect(await screen.findByTestId('stub-SlackInteractionsPanel')).toBeInTheDocument()

    rerender(<OperationsPage permissions={['recovery.read']} />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-access'))
    expect(await screen.findByTestId('stub-MemoryGovernancePanel')).toBeInTheDocument()
  })

  it('does not mount a persisted section after its permissions are removed', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'integrations')
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage permissions={['recovery.read']} />)

    expect(await screen.findByTestId('operations-rail-tab-overview'))
      .toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('stub-McpConnectionsPanel')).toBeNull()
    expect(screen.queryByTestId('stub-SlackInteractionsPanel')).toBeNull()
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBe('overview'))
  })

  it('rejects inaccessible section requests without persisting them', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage permissions={['recovery.read']} />)
    await screen.findByTestId('settings-index-access')

    act(() => requestOperationsSection('integrations'))

    expect(screen.getByTestId('operations-rail-tab-overview'))
      .toHaveAttribute('aria-current', 'page')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('overview')
    expect(screen.queryByTestId('stub-McpConnectionsPanel')).toBeNull()
  })
})
