import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import {
  RecoveryCenterPanel,
  buildGreeting,
  computeRecommendedActions,
  humanizeAge,
  readErrorSignature,
  type RecommendedActionSignals,
} from './RecoveryCenterPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const bumpPlatformVersion = vi.fn()
const addToast = vi.fn()

vi.mock('../store', () => ({
  useWorkflowStore: (
    selector: (state: { bumpPlatformVersion: () => void; addToast: typeof addToast; user: unknown; platformVersion: number }) => unknown,
  ) => selector({ bumpPlatformVersion, addToast, user: { email: 'jane@example.com' }, platformVersion: 0 }),
}))

const baseProps = {
  runs: [],
  runNodes: [],
  deadLetters: [],
  activeRunId: null,
  onOpenTab: vi.fn(),
  onOpenRun: vi.fn(),
  onApproveNode: vi.fn(),
  onSubmitHumanForm: vi.fn(),
}

const baseMetrics = {
  successRate: { value: 87, display: '87%', severity: 'healthy', rationale: 'Workflow success rate' },
  mttr: { value: 12, display: '12m', severity: 'warn', rationale: 'Mean time to recovery' },
  p95Latency: { value: 240, display: '240ms', severity: 'healthy', rationale: 'p95 latency' },
  approvalsPending: { value: 0, display: '0', severity: 'healthy', rationale: 'No human action waiting' },
  replayRate: { value: 78, display: '78%', severity: 'healthy', rationale: 'Replay success rate' },
  windowDays: 30,
  terminalRuns: 87,
}

const baseClusters = { clusters: [], totalSamples: 0, windowDays: 30 }

beforeEach(() => {
  vi.mocked(api).mockReset()
  bumpPlatformVersion.mockReset()
  addToast.mockReset()
  baseProps.onOpenTab = vi.fn()
  baseProps.onOpenRun = vi.fn()
  baseProps.onApproveNode = vi.fn()
  baseProps.onSubmitHumanForm = vi.fn()
})

// ─────────────────────────────────────────────────────────────────────────
// computeRecommendedActions — 6 priority-rule fixtures
// ─────────────────────────────────────────────────────────────────────────

describe('computeRecommendedActions', () => {
  it('prioritizes pending approvals first when waiting nodes > 0', () => {
    const signals: RecommendedActionSignals = {
      openFailures: 5,
      pendingApprovals: 2,
      topClusterFrequency: 4,
      healthScore: 55,
      totalRuns: 100,
    }
    const actions = computeRecommendedActions(signals)
    expect(actions[0]!.id).toBe('resolve_approvals')
    expect(actions[0]!.severity).toBe('warning')
    expect(actions[0]!.ctaTab).toBe('runs')
    expect(actions[0]!.title).toContain('Resolve 2 approval')
  })

  it('falls through to recover_cluster when no approvals but a frequency-≥2 cluster exists', () => {
    const actions = computeRecommendedActions({
      openFailures: 5,
      pendingApprovals: 0,
      topClusterFrequency: 4,
      healthScore: 90,
      totalRuns: 50,
    })
    expect(actions[0]!.id).toBe('recover_cluster')
    expect(actions[0]!.severity).toBe('cobalt')
    expect(actions[0]!.ctaTab).toBe('operations')
    expect(actions[0]!.title).toContain('Recover all 4')
  })

  it('falls through to triage_failures when no approvals and no qualifying cluster', () => {
    const actions = computeRecommendedActions({
      openFailures: 3,
      pendingApprovals: 0,
      topClusterFrequency: 1,
      healthScore: 90,
      totalRuns: 50,
    })
    expect(actions[0]!.id).toBe('triage_failures')
    expect(actions[0]!.severity).toBe('warning')
    expect(actions[0]!.title).toContain('triage 3 failure')
  })

  it('flags review_workflow_risk with severity danger when health < 60', () => {
    const actions = computeRecommendedActions({
      openFailures: 0,
      pendingApprovals: 0,
      topClusterFrequency: 0,
      healthScore: 45,
      totalRuns: 50,
    })
    expect(actions[0]!.id).toBe('review_workflow_risk')
    expect(actions[0]!.severity).toBe('danger')
  })

  it('flags review_workflow_risk with severity warning when health 60-79', () => {
    const actions = computeRecommendedActions({
      openFailures: 0,
      pendingApprovals: 0,
      topClusterFrequency: 0,
      healthScore: 72,
      totalRuns: 50,
    })
    expect(actions[0]!.id).toBe('review_workflow_risk')
    expect(actions[0]!.severity).toBe('warning')
  })

  it('surfaces the getting-started demo for new operators with no signals', () => {
    const actions = computeRecommendedActions({
      openFailures: 0,
      pendingApprovals: 0,
      topClusterFrequency: 0,
      healthScore: 90,
      totalRuns: 2,
    })
    expect(actions[0]!.id).toBe('run_getting_started')
    expect(actions[0]!.severity).toBe('cyan')
    // CTA routes to AI Studio so the operator can draft a real first flow
    // (the previous "Browse recipes" placeholder pointed at a demo recipe
    // that doesn't exist).
    expect(actions[0]!.ctaTab).toBe('copilot')
  })

  it('falls through to healthy_try_studio when every signal is clean', () => {
    const actions = computeRecommendedActions({
      openFailures: 0,
      pendingApprovals: 0,
      topClusterFrequency: 0,
      healthScore: 95,
      totalRuns: 100,
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]!.id).toBe('healthy_try_studio')
    expect(actions[0]!.severity).toBe('success')
    expect(actions[0]!.ctaTab).toBe('copilot')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// buildGreeting — time-of-day + posture
// ─────────────────────────────────────────────────────────────────────────

describe('buildGreeting', () => {
  it('says "Good morning" before noon', () => {
    const g = buildGreeting({ hour: 9, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10 })
    expect(g.salutation).toBe('Good morning, Jane.')
  })
  it('says "Good afternoon" 12-17', () => {
    const g = buildGreeting({ hour: 14, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10 })
    expect(g.salutation).toBe('Good afternoon, Jane.')
  })
  it('says "Good evening" after 18', () => {
    const g = buildGreeting({ hour: 20, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10 })
    expect(g.salutation).toBe('Good evening, Jane.')
  })
  it('drops the name filler when displayName is null', () => {
    // Operator with no resolvable name reads cleaner as "Good morning."
    // than "Good morning, there." — the former feels intentional, the
    // latter feels like a stale placeholder.
    const g = buildGreeting({ hour: 9, displayName: null, openFailures: 0, pendingApprovals: 0, healthScore: null, totalRuns: 0 })
    expect(g.salutation).toBe('Good morning.')
  })
  it('subline reflects approvals waiting', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 3, pendingApprovals: 2, healthScore: 80, totalRuns: 50 })
    expect(g.subline).toContain('2 approval')
  })
  it('subline reflects open failures when no approvals', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 3, pendingApprovals: 0, healthScore: 80, totalRuns: 50 })
    expect(g.subline).toContain('3 run')
  })
  it('subline celebrates when health ≥ 80 and no signals', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 0, pendingApprovals: 0, healthScore: 96, totalRuns: 50 })
    expect(g.subline).toContain('All clear')
  })
  it('subline falls to the clean-posture line when no runs yet (the pitch carries the welcome)', () => {
    // The hero pitch right below the greeting already explains what
    // Janusly does — duplicating that with a "Welcome to Janusly" subline
    // wastes attention. New-operator subline now matches the steady-state
    // clean posture: "Recovery posture is clean across the last 30 days."
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 0, pendingApprovals: 0, healthScore: null, totalRuns: 0 })
    expect(g.subline).toContain('Recovery posture is clean')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Tiny helpers
// ─────────────────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('humanizeAge formats recent time correctly', () => {
    const now = Date.parse('2026-05-13T12:00:00Z')
    expect(humanizeAge('2026-05-13T11:58:00Z', now)).toBe('2m ago')
    expect(humanizeAge('2026-05-13T10:00:00Z', now)).toBe('2h ago')
    expect(humanizeAge('2026-05-10T12:00:00Z', now)).toBe('3d ago')
    expect(humanizeAge(undefined, now)).toBe('')
  })
  it('readErrorSignature picks signature > message > error > Failed', () => {
    expect(readErrorSignature({ signature: 'sig' })).toBe('sig')
    expect(readErrorSignature({ message: 'msg' })).toBe('msg')
    expect(readErrorSignature({ error: 'err' })).toBe('err')
    expect(readErrorSignature(null)).toBe('Failed')
    expect(readErrorSignature({ something: 'else' })).toBe('Failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterPanel render — empty + populated + CTA routing
// ─────────────────────────────────────────────────────────────────────────

describe('<RecoveryCenterPanel /> — empty state', () => {
  it('renders the welcome hero when no runs / no DLQ / no waiting nodes', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByTestId('recovery-flow-demo')).toBeInTheDocument()
    })
    expect(screen.getByText('From failure to fix in one screen.')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-empty-cta-studio')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-empty-cta-recipes')).toBeInTheDocument()
  })

  it('opens AI Studio when the empty-state Studio CTA is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await waitFor(() => expect(screen.getByTestId('recovery-flow-demo')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-studio'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('copilot')
  })

  it('opens Recipes when the empty-state Recipes CTA is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await waitFor(() => expect(screen.getByTestId('recovery-flow-demo')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-recipes'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('templates')
  })
})

describe('<RecoveryCenterPanel /> — populated state', () => {
  const populatedRuns = [{ id: 'run-1', status: 'failed' }, { id: 'run-2', status: 'succeeded' }]
  const populatedDlq = [
    { id: 'dlq-1', runId: 'run-1', nodeId: 'http-call', attempt: 2, status: 'open' as const, workflowJson: { name: 'Invoice flow' }, nodeJson: {}, errorJson: { signature: 'HTTP 401 on http node' }, createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    { id: 'dlq-2', runId: 'run-3', nodeId: 'ai-node', attempt: 1, status: 'open' as const, workflowJson: { name: 'Daily summary' }, nodeJson: {}, errorJson: { signature: 'AI provider quota' }, createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
  ]
  const populatedNodes = [{ nodeId: 'human-approve', status: 'waiting', stateJson: { waiting: { kind: 'approval', title: 'Approve invoice' } } }]
  const populatedClusters = {
    clusters: [
      { signature: 'Missing secret: GITHUB_TOKEN', category: 'secret_missing' as const, frequency: 3, suggestedOwner: 'ops' as const, lastSeen: new Date().toISOString() },
    ],
    totalSamples: 5,
    windowDays: 30,
  }

  it('renders all four tiles when signals are populated', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)

    await waitFor(() => {
      expect(screen.getByTestId('recovery-center-tile-queue')).toBeInTheDocument()
      expect(screen.getByTestId('recovery-center-tile-clusters')).toBeInTheDocument()
      expect(screen.getByTestId('recovery-center-tile-approvals')).toBeInTheDocument()
      expect(screen.getByTestId('recovery-center-tile-actions')).toBeInTheDocument()
    })
    expect(screen.getByText('Invoice flow')).toBeInTheDocument()
    expect(screen.getByText('Missing secret: GITHUB_TOKEN')).toBeInTheDocument()
    expect(screen.getByText('Approve invoice')).toBeInTheDocument()
  })

  it('routes Open queue → runs tab', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-queue-open-all')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-queue-open-all'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('runs')
  })

  it('routes Open clusters → operations tab', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-clusters-open-all')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-clusters-open-all'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('operations')
  })

  it('clicking a recovery-queue row opens the underlying run + Runs tab', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-queue-row-dlq-1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-queue-row-dlq-1'))
    expect(baseProps.onOpenRun).toHaveBeenCalledWith('run-1')
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('runs')
  })

  it('clicking a metric strip cell routes to the expected detail tab', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-metric-failures')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-metric-failures'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('runs')
    fireEvent.click(screen.getByTestId('recovery-center-metric-mttr'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
    fireEvent.click(screen.getByTestId('recovery-center-metric-approvals'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('runs')
    fireEvent.click(screen.getByTestId('recovery-center-metric-replay'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
  })

  it('recommended-actions tile leads with the approvals action when approvals are pending', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-action-resolve_approvals')).toBeInTheDocument())
    // The first action's CTA is the "Open runs" routing for approvals.
    fireEvent.click(screen.getByTestId('recovery-center-action-cta-resolve_approvals'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('runs')
  })

  it('renders the Recovery Center-greeting header with the user display name', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={populatedRuns as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => {
      const greeting = screen.getByTestId('recovery-center-greeting')
      expect(greeting.textContent).toMatch(/jane/i)
    })
  })
})

describe('<RecoveryCenterPanel /> — degraded metrics endpoint', () => {
  it('surfaces a soft warning when /recovery/metrics fails but still renders tiles', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') throw new Error('Recovery metrics unavailable')
      if (path === '/dlq/clusters') return baseClusters
      // The Budget tile (5th tile) reads /billing/budget on the same
      // tick; stub a no-budget envelope so the test doesn't trip on an
      // unmatched fetch.
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel
      {...baseProps}
      runs={[{ id: 'r1', status: 'failed' }] as never}
      runNodes={[]}
      deadLetters={[{ id: 'dlq-x', runId: 'r1', nodeId: 'http', attempt: 1, status: 'open', workflowJson: { name: 'Demo' }, nodeJson: {}, errorJson: { signature: 'HTTP 401' }, createdAt: new Date().toISOString() }] as never}
    />)

    await waitFor(() => {
      // Targeted match — the empty-budget tile also exposes role="status"
      // text now that the budget tile is in the grid, so we filter by the
      // unique "Metrics unavailable" copy instead of role-only.
      const statuses = screen.getAllByRole('status')
      const banner = statuses.find((node) => /Metrics unavailable/i.test(node.textContent ?? ''))
      expect(banner).toBeDefined()
      expect(banner).toHaveTextContent(/Metrics unavailable/i)
    })
    // The Recovery Center still renders the populated tiles even when metrics fail.
    expect(screen.getByTestId('recovery-center-tile-queue')).toBeInTheDocument()
  })
})
