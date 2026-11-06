import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../api'
import { changeAppLanguage } from '../i18n'
import { MalformedResponseError } from '../lib/malformed-response'
import { useWorkflowStore } from '../store'
import { OperationsPage } from './OperationsPage'
import { requestOperationsSection, useRouteOpsSection } from './operations-section-bus'

vi.mock('../api', async (importOriginal) => {
  // The real module keeps ApiError and its status helpers; only the transport is doubled.
  const actual = await importOriginal<typeof import('../api')>()
  const module = ({
  api: vi.fn(),
})
  return {
    ...actual,
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

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
vi.mock('./AuditLogPanel', () => ({
  AuditLogPanel: () => <section data-testid="stub-AuditLogPanel">Audit</section>,
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
    window.history.replaceState(null, '', '/')
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
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
    expect(screen.getByTestId('settings-index-organization')).toHaveTextContent('Organization')
    expect(screen.getByTestId('settings-index-integrations')).toBeInTheDocument()
    expect(screen.getByTestId('settings-index-integrations')).toHaveTextContent('Connections')
    expect(screen.getByTestId('settings-index-ai')).toBeInTheDocument()
    expect(screen.getByTestId('settings-index-ai')).toHaveTextContent('AI configuration')
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

    const onOpenTab = vi.fn()
    render(<OperationsPage onOpenTab={onOpenTab} />)
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

    fireEvent.click(screen.getByTestId('settings-usage-open-cost-steps'))
    expect(onOpenTab).toHaveBeenCalledWith('reports')

    await changeAppLanguage('es')
    expect(costTable).toHaveAccessibleName('Tabla de desglose de costo')
  })

  it.each([
    ['loading', () => new Promise(() => undefined), 'settings-usage-loading', 'Loading…'],
    ['forbidden', () => Promise.reject(new ApiError('Forbidden', { statusCode: 403 })), 'settings-usage-unavailable', "Couldn't load usage totals."],
    ['malformed', () => Promise.reject(new MalformedResponseError()), 'settings-usage-unavailable', "Couldn't load usage totals."],
  ])('never shows a %s usage read as no usage, and keeps the link to the steps', async (_state, read, testId, copy) => {
    await changeAppLanguage('en')
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/recovery/metrics')) return read()
      if (path === '/system/queue') return clearQueue
      return null
    })
    render(<OperationsPage permissions={['recovery.read', 'runs.read']} />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-usage'))
    expect(await screen.findByTestId(testId)).toHaveTextContent(copy)
    expect(screen.queryByText('No AI usage in the last 30 days')).toBeNull()
    expect(screen.getByTestId('settings-usage-open-cost-steps')).toBeInTheDocument()
  })

  it('states an empty window with AI-only copy and keeps the link to the steps', async () => {
    stubApiByPath({
      '/recovery/metrics': { ...healthyMetrics, costThisWindow: { ...healthyMetrics.costThisWindow, providers: [] } },
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })
    render(<OperationsPage permissions={['recovery.read', 'runs.read']} />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-usage'))
    expect(await screen.findByText('No AI usage in the last 30 days')).toBeInTheDocument()
    expect(screen.getByText(/Only AI calls are priced/)).toBeInTheDocument()
    expect(screen.getByTestId('settings-usage-open-cost-steps')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-usage-unavailable')).toBeNull()
    await changeAppLanguage('es')
    expect(await screen.findByText('Sin uso de IA en los últimos 30 días')).toBeInTheDocument()
    await changeAppLanguage('en')
  })

  it('offers the cost steps only to an operator who can open Reports and its runs', async () => {
    stubApiByPath({
      '/recovery/metrics': {
        ...healthyMetrics,
        costThisWindow: {
          ...healthyMetrics.costThisWindow,
          providers: [{
            provider: 'Anthropic', model: 'haiku', usd: 1, tokens: 1, inputTokens: 1,
            cachedInputTokens: 0, cacheCreationInputTokens: 0, calls: 1,
          }],
        },
      },
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })
    const { unmount } = render(<OperationsPage permissions={['recovery.read']} />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-usage'))
    await screen.findByTestId('settings-usage-cost-table')
    expect(screen.queryByTestId('settings-usage-open-cost-steps')).toBeNull()
    unmount()

    render(<OperationsPage permissions={['recovery.read', 'runs.read']} />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-usage'))
    expect(await screen.findByTestId('settings-usage-open-cost-steps')).toBeInTheDocument()
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
    // (those sub-tabs have no page-level signal source).
    expect(screen.queryByTestId('operations-rail-dot-overview')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-access')).toBeNull()
    expect(screen.queryByTestId('operations-rail-dot-integrations')).toBeNull()
  })

  it('shows admin queue pressure and lights Infrastructure only above the threshold', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] }, queue: { degraded: true } },
      '/system/queue': { waiting: 3, active: 2, oldestWaitingSeconds: 91, warnSeconds: 60 },
      '/system/workers': { status: 'degraded', staleAfterSeconds: 60 },
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
    const fleet = screen.getByTestId('worker-fleet-row')
    expect(fleet).toHaveTextContent('Some execution workers have stopped reporting.')
    expect(fleet).not.toHaveTextContent(/live|stale|instance|commit/i)
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

  it('attributes an explicit null maintenance snapshot to the queue store, not transport', async () => {
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
    expect(maintenance).toHaveTextContent('Maintenance status unavailable — the queue store could not be read')
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
    expect(chip).toHaveTextContent('Queue status unavailable — the queue store could not be read')
    expect(screen.getByTestId('operations-rail-dot-infrastructure')).toHaveAttribute('data-severity', 'warning')
  })

  it('does not diagnose an initial queue request failure as a queue-store failure', async () => {
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
    expect(chip).not.toHaveTextContent('the queue store could not be read')
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

    render(<OperationsPage onOpenTab={onOpenTab} />)

    const search = await screen.findByLabelText('Search settings…')
    fireEvent.change(search, { target: { value: 'queue' } })
    expect(screen.getByTestId('settings-index-infrastructure')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-index-reliability')).toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Connections' }))
    expect(onOpenTab).toHaveBeenCalledWith('credentials')
  })

  it('separates organization policy from access and names each focused area', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
    })

    render(<OperationsPage />)

    fireEvent.click(await screen.findByTestId('settings-index-organization'))
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeInTheDocument()
    expect(await screen.findByTestId('stub-MemoryGovernancePanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-AuditLogPanel')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-AuthPolicySettingsPanel')).toBeNull()

    fireEvent.click(screen.getByTestId('operations-rail-tab-access'))
    expect(screen.getByRole('heading', { name: 'Access' })).toBeInTheDocument()
    expect(await screen.findByTestId('stub-AuthPolicySettingsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-ScimDirectorySettingsPanel')).toBeInTheDocument()
    expect(screen.getByTestId('stub-PermissionGrantsPanel')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-MemoryGovernancePanel')).toBeNull()
    expect(screen.queryByTestId('stub-AuditLogPanel')).toBeNull()

    fireEvent.click(screen.getByTestId('operations-rail-tab-integrations'))
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('operations-rail-tab-ai'))
    expect(screen.getByRole('heading', { name: 'AI configuration' })).toBeInTheDocument()
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

  it('routes credential readers from Connections to the canonical inventory', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Open Connections' }))
    expect(onOpenTab).toHaveBeenCalledWith('credentials')
  })

  it('keeps write-only connection and recovery-governance sections reachable', async () => {
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
    fireEvent.click(await screen.findByTestId('operations-rail-tab-organization'))
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
    await screen.findByTestId('settings-index-organization')

    act(() => requestOperationsSection('integrations'))

    expect(screen.getByTestId('operations-rail-tab-overview'))
      .toHaveAttribute('aria-current', 'page')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('overview')
    expect(screen.queryByTestId('stub-McpConnectionsPanel')).toBeNull()
  })
})

describe('<OperationsPage /> pane route', () => {
  const healthy = { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }

  beforeEach(() => {
    window.history.replaceState(null, '', '/#/operations/overview')
    window.localStorage.removeItem(STORAGE_KEY)
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
    stubApiByPath({ '/recovery/metrics': healthyMetrics, '/health': healthy })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  const goToHash = (hash: string) => act(() => {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

  it('follows a hash changed while the page is open', async () => {
    render(<OperationsPage />)
    await screen.findByTestId('settings-index-reliability')

    goToHash('#/operations/access')

    expect(screen.getByTestId('operations-rail-tab-access')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('stub-PermissionGrantsPanel')).toBeInTheDocument()
  })

  it.each(['#/operations/nonsense', '#/operations'])('rewrites %s to the open pane', async (hash) => {
    render(<OperationsPage />)
    fireEvent.click(await screen.findByTestId('operations-rail-tab-usage'))

    goToHash(hash)

    expect(window.location.hash).toBe('#/operations/usage')
    expect(screen.getByTestId('operations-rail-tab-usage')).toHaveAttribute('aria-current', 'page')
  })

  it('refuses a hash naming a pane the viewer cannot open', async () => {
    render(<OperationsPage permissions={['recovery.read']} />)
    await screen.findByTestId('settings-index-organization')

    goToHash('#/operations/integrations')

    expect(window.location.hash).toBe('#/operations/overview')
    expect(screen.queryByTestId('stub-McpConnectionsPanel')).toBeNull()
  })

  it('gives a pane change its own history entry so Back returns to the previous pane', async () => {
    const push = vi.spyOn(window.history, 'pushState')
    render(<OperationsPage />)

    fireEvent.click(await screen.findByTestId('settings-index-reliability'))

    expect(window.location.hash).toBe('#/operations/reliability')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('exposes the routed pane to the shell breadcrumb', () => {
    const { result } = renderHook(() => useRouteOpsSection())
    expect(result.current).toBe('overview')

    goToHash('#/operations/access')
    expect(result.current).toBe('access')

    goToHash('#/operations/nonsense')
    expect(result.current).toBeNull()

    goToHash('#/runs')
    expect(result.current).toBeNull()
  })
})

describe('<OperationsPage /> settings index status lines', () => {
  const healthy = { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }
  const areaReads = {
    '/alerts/policies': { policies: [] },
    '/dlq/clusters': { clusters: [{ signature: 'a' }] },
    '/org/roles': { roles: [{}, {}, {}] },
    '/org/config': { config: [{ key: 'auth.mfaRequired', value: true }] },
    '/credentials': [{}, {}],
    '/mcp/connections': { connections: [{}] },
    '/memory/consent-status': { enabled: false, processEnabled: true, tenantEnabled: false },
  }
  const status = (area: string) => screen.queryByTestId(`settings-index-status-${area}`)

  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    window.localStorage.removeItem(STORAGE_KEY)
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
  })

  it('shows counts read from the existing endpoints', async () => {
    stubApiByPath({
      ...areaReads,
      '/recovery/metrics': {
        ...healthyMetrics,
        costThisWindow: { ...healthyMetrics.costThisWindow, value: 12.5, display: '$12.50', providers: [{ provider: 'p', model: 'm' }] },
      },
      '/health': healthy,
      '/system/queue': { waiting: 3, active: 1, oldestWaitingSeconds: 5, warnSeconds: 60 },
    })

    render(<OperationsPage />)

    await waitFor(() => expect(status('reliability')).toHaveTextContent('0 alert policies · 1 failure pattern'))
    expect(status('access')).toHaveTextContent('3 roles · MFA required')
    expect(status('integrations')).toHaveTextContent('2 credentials · 1 MCP connection')
    expect(status('usage')).toHaveTextContent('$12.50 in 30 days')
    await waitFor(() => expect(status('infrastructure')).toHaveTextContent('3 jobs queued'))
  })

  it('omits a count whose read failed and the line when none was read', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') return healthy
      if (path === '/alerts/policies') return { policies: [{}] }
      if (path === '/org/roles') return { unexpected: true }
      if (path === '/org/config') return { unexpected: true }
      throw new Error('boom')
    })

    render(<OperationsPage />)

    await waitFor(() => expect(status('reliability')).toHaveTextContent(/^1 alert policy$/))
    expect(status('access')).toBeNull()
    expect(status('integrations')).toBeNull()
    expect(status('organization')).toBeNull()
  })

  it('never reads a count the viewer may not see', async () => {
    stubApiByPath({ ...areaReads, '/recovery/metrics': healthyMetrics, '/health': healthy })

    render(<OperationsPage permissions={['recovery.read', 'alerts.read']} />)

    await waitFor(() => expect(status('reliability')).toHaveTextContent(/^0 alert policies$/))
    const paths = vi.mocked(api).mock.calls.map(([path]) => path)
    for (const denied of ['/dlq/clusters', '/org/roles', '/org/config', '/credentials', '/mcp/connections']) {
      expect(paths).not.toContain(denied)
    }
  })

  it('stays quiet about usage on an unreadable payload and says so when there is none', async () => {
    stubApiByPath({ '/recovery/metrics': {}, '/health': healthy })
    const { unmount } = render(<OperationsPage />)
    await screen.findByTestId('settings-index-reliability')
    expect(status('usage')).toBeNull()
    unmount()

    stubApiByPath({ '/recovery/metrics': healthyMetrics, '/health': healthy })
    render(<OperationsPage />)
    await waitFor(() => expect(status('usage')).toHaveTextContent('No usage in 30 days'))
  })

  it('reports clear queues only once they were checked', async () => {
    stubApiByPath({ '/recovery/metrics': healthyMetrics, '/health': healthy, '/system/queue': clearQueue })
    render(<OperationsPage />)
    await waitFor(() => expect(status('infrastructure')).toHaveTextContent('All queues clear'))
  })

  it('says nothing about queues the viewer cannot check', async () => {
    stubApiByPath({ '/recovery/metrics': healthyMetrics, '/health': healthy })
    render(<OperationsPage permissions={['recovery.read']} />)
    await waitFor(() => expect(status('usage')).toHaveTextContent('No usage in 30 days'))
    expect(status('infrastructure')).toBeNull()
  })

  it('drops the previous workspace counts when the organization changes', async () => {
    stubApiByPath({ ...areaReads, '/recovery/metrics': healthyMetrics, '/health': healthy })
    render(<OperationsPage />)
    await waitFor(() => expect(status('access')).toHaveTextContent('3 roles'))

    let release: (value: unknown) => void = () => undefined
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { release = resolve }))
    act(() => useWorkflowStore.setState({ orgId: 'other-org' }))

    expect(status('access')).toBeNull()
    release(null)
  })
})

describe('<OperationsPage /> attention dot reasons', () => {
  const healthy = { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } }

  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    window.localStorage.removeItem(STORAGE_KEY)
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
  })

  const expectReason = async (section: string, reason: string | RegExp) => {
    await waitFor(() => expect(screen.getByTestId(`operations-rail-dot-${section}`)).toHaveAccessibleName(reason))
    expect(screen.getByTestId(`operations-rail-tab-${section}`).title).toMatch(reason)
  }

  it('explains the Reliability and index dots with the unhealthy metric', async () => {
    stubApiByPath({
      '/recovery/metrics': {
        ...healthyMetrics,
        successRate: {
          value: 71.4,
          display: '71.4%',
          severity: 'unhealthy',
          rationale: 'fallback',
          rationaleCode: 'success_rate.summary',
          rationaleMeta: { succeeded: 5, terminal: 7 },
        },
      },
      '/health': healthy,
    })

    render(<OperationsPage />)

    const reason = '71.4% — 5 of 7 terminal runs succeeded.'
    await expectReason('reliability', reason)
    await expectReason('overview', reason)
    expect(screen.queryByTestId('operations-rail-dot-usage')).toBeNull()
    expect(screen.getByTestId('operations-rail-tab-usage')).not.toHaveAttribute('title')
  })

  it('explains the Usage dot and adds it to the index dot', async () => {
    stubApiByPath({
      '/recovery/metrics': {
        ...healthyMetrics,
        costThisWindow: { ...healthyMetrics.costThisWindow, value: 900, display: '$900', severity: 'unhealthy', rationale: 'Over budget.' },
      },
      '/health': healthy,
    })

    render(<OperationsPage />)

    await expectReason('usage', '$900 — Over budget.')
    await expectReason('overview', '$900 — Over budget.')
    expect(screen.queryByTestId('operations-rail-dot-reliability')).toBeNull()
  })

  it('explains the AI dot with the blocked budget scope', async () => {
    useWorkflowStore.setState({
      budgetBlocked: { exceededAt: 'workflow' } as never,
    })
    stubApiByPath({ '/recovery/metrics': healthyMetrics, '/health': healthy })

    render(<OperationsPage />)

    await expectReason('ai', /workflow budget exceeded/)
    expect(screen.getByTestId('operations-rail-dot-ai')).toHaveAttribute('data-severity', 'danger')
  })

  it('explains the Infrastructure dot for each issue', async () => {
    stubApiByPath({
      '/recovery/metrics': healthyMetrics,
      '/health': {
        ok: true,
        rateLimiter: {
          healthy: false,
          degradedBuckets: [{ bucket: 'ai', errorCount: 4, firstObservedAt: 'x', lastObservedAt: 'x' }],
        },
      },
      '/system/queue': {
        waiting: 9,
        active: 0,
        oldestWaitingSeconds: 300,
        warnSeconds: 60,
        maintenance: { waiting: 1, active: 1, oldestWaitingSeconds: 300, warnSeconds: 60 },
      },
    })

    render(<OperationsPage />)

    await expectReason('infrastructure', /Rate limiter degraded — 1 bucket failing open/)
    await expectReason('infrastructure', /Workflow queue delayed; work is waiting for a worker/)
    await expectReason('infrastructure', /Maintenance queue delayed; maintenance workers are still processing/)
    expect(screen.getByTestId('settings-index-status-infrastructure')).toHaveTextContent(/Rate limiter degraded/)
  })

  it('names an unreadable queue instead of calling it clear', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return healthyMetrics
      if (path === '/health') return healthy
      if (path === '/system/queue') throw new Error('offline')
      return null
    })

    render(<OperationsPage />)

    await expectReason('infrastructure', /Queue status unavailable — request failed/)
    expect(screen.getByTestId('settings-index-status-infrastructure')).not.toHaveTextContent('All queues clear')
  })
})

describe('<OperationsPage /> survives payloads the contract did not promise', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
  })

  // Every one of these used to throw inside the Operations panel:
  // `metrics?.costThisWindow.severity` stops at `metrics`, not at the missing
  // `costThisWindow`, and `.some((m) => m.severity)` walked undefined metrics.
  for (const [label, payload] of [
    ['empty object', {}],
    ['metric objects missing', { windowDays: 30, terminalRuns: 10 }],
    ['metric fields null', { successRate: null, mttr: null, p95Latency: null, replayRate: null, costThisWindow: null }],
    ['array instead of object', []],
    ['string body', 'garbage'],
  ] as const) {
    it(`renders the overview with ${label}`, async () => {
      stubApiByPath({
        '/recovery/metrics': payload,
        '/health': { ok: true, rateLimiter: { healthy: true, degradedBuckets: [] } },
      })
      render(<OperationsPage />)
      await screen.findByTestId('settings-index-reliability')
      expect(screen.getByTestId('operations-rail-tab-overview')).toHaveAttribute('aria-current', 'page')
    })
  }
})
