import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
