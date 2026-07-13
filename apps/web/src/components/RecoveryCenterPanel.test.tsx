import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { RecoveryCenterPanel } from './RecoveryCenterPanel'
import {
  consumeRecoveryAllClear,
  requestRecoveryAllClear,
} from './recovery-all-clear-bus'
import { consumeRecoveryFocusDay } from './recovery-day-focus-bus'
import {
  buildGreeting,
  computeRecommendedActions,
  humanizeAge,
  readErrorSignature,
  type RecommendedActionSignals,
} from './recovery-center/helpers'

vi.mock('../api', () => ({ api: vi.fn() }))

const bumpPlatformVersion = vi.fn()
const addToast = vi.fn()
const dismissRecoveryIntroThisSession = vi.fn()
let activeOrgId: string | null = 'default'

vi.mock('../store', () => ({
  useWorkflowStore: (
    selector: (state: {
      bumpPlatformVersion: () => void
      addToast: typeof addToast
      user: unknown
      platformVersion: number
      orgId: string | null
      recoveryIntroDismissedThisSession: boolean
      dismissRecoveryIntroThisSession: typeof dismissRecoveryIntroThisSession
    }) => unknown,
  ) => selector({
    bumpPlatformVersion,
    addToast,
    user: { email: 'jane@example.com' },
    platformVersion: 0,
    orgId: activeOrgId,
    recoveryIntroDismissedThisSession: false,
    dismissRecoveryIntroThisSession,
  }),
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
  onOpenRecoveryQueue: vi.fn(),
}

const baseMetrics = {
  successRate: { value: 87, display: '87%', severity: 'healthy', rationale: 'Workflow success rate' },
  mttr: { value: 12, display: '12m', severity: 'warn', rationale: 'Mean time to recovery' },
  p95Latency: { value: 240, display: '240ms', severity: 'healthy', rationale: 'p95 latency' },
  approvalsPending: { value: 0, display: '0', severity: 'healthy', rationale: 'No human action waiting' },
  replayRate: { value: 78, display: '78%', severity: 'healthy', rationale: 'Replay success rate' },
  slaAttainment: { value: 92, display: '92.0%', severity: 'healthy', rationale: 'SLA attainment', rationaleCode: 'sla_attainment.summary', rationaleMeta: { metSla: 46, resolvedInWindow: 50 } },
  windowDays: 30,
  terminalRuns: 87,
}

const baseClusters = { clusters: [], totalSamples: 0, windowDays: 30 }

beforeEach(() => {
  consumeRecoveryAllClear()
  consumeRecoveryFocusDay()
  vi.mocked(api).mockReset()
  bumpPlatformVersion.mockReset()
  addToast.mockReset()
  dismissRecoveryIntroThisSession.mockReset()
  activeOrgId = 'default'
  localStorage.removeItem('janusly:recovery:hideIntro')
  baseProps.onOpenTab = vi.fn()
  baseProps.onOpenRun = vi.fn()
  baseProps.onApproveNode = vi.fn()
  baseProps.onSubmitHumanForm = vi.fn()
  baseProps.onOpenRecoveryQueue = vi.fn()
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
  it('renders urgent metrics without waiting for the contextual heatmap', async () => {
    let releaseHeatmap: ((value: unknown) => void) | undefined
    const pendingHeatmap = new Promise((resolve) => { releaseHeatmap = resolve })
    const readyClusters = {
      clusters: [{
        signature: 'Slow heatmap cluster',
        category: 'unknown' as const,
        frequency: 2,
        suggestedOwner: 'platform' as const,
        lastSeen: new Date().toISOString(),
      }],
      totalSamples: 2,
      windowDays: 30,
    }
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return readyClusters
      if (path === '/recovery/heatmap?days=90') return pendingHeatmap
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls.map(([path]) => path)
      expect(calls).toEqual(expect.arrayContaining([
        '/recovery/metrics',
        '/dlq/clusters',
        '/recovery/heatmap?days=90',
      ]))
      expect(screen.getByTestId('recovery-center-metric-mttr')).toHaveTextContent('12m')
      expect(screen.getByText('Slow heatmap cluster')).toBeInTheDocument()
    })
    releaseHeatmap?.({ days: [] })
  })

  it('waits for terminal-run history before exposing the walkthrough dismissal', async () => {
    let releaseMetrics: ((value: unknown) => void) | undefined
    const pendingMetrics = new Promise((resolve) => { releaseMetrics = resolve })
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return pendingMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    expect(screen.queryByTestId('recovery-flow-demo')).not.toBeInTheDocument()

    releaseMetrics?.({ ...baseMetrics, terminalRuns: 0 })
    expect(await screen.findByTestId('recovery-flow-demo')).toBeInTheDocument()
  })

  it('does not render a previous organization snapshot during an org switch', async () => {
    let releaseFirstMetrics: ((value: unknown) => void) | undefined
    const firstMetrics = new Promise((resolve) => { releaseFirstMetrics = resolve })
    let metricsCalls = 0
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') {
        metricsCalls += 1
        if (metricsCalls === 1) return firstMetrics
        return { ...baseMetrics, mttr: { ...baseMetrics.mttr, value: 22, display: '22m' } }
      }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    const { rerender } = render(<RecoveryCenterPanel {...baseProps} />)
    await waitFor(() => expect(metricsCalls).toBe(1))
    activeOrgId = 'org-b'
    rerender(<RecoveryCenterPanel {...baseProps} />)
    await waitFor(() => {
      expect(metricsCalls).toBe(2)
      expect(screen.getByTestId('recovery-center-metric-mttr')).toHaveTextContent('22m')
    })

    releaseFirstMetrics?.({ ...baseMetrics, mttr: { ...baseMetrics.mttr, value: 99, display: '99m' } })
    await Promise.resolve()
    expect(screen.getByTestId('recovery-center-metric-mttr')).not.toHaveTextContent('99m')
  })

  it('does not render a previous organization metrics error during an org switch', async () => {
    let releaseSecondMetrics: ((value: unknown) => void) | undefined
    const secondMetrics = new Promise((resolve) => { releaseSecondMetrics = resolve })
    let metricsCalls = 0
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') {
        metricsCalls += 1
        if (metricsCalls === 1) throw new Error('Org A metrics failed')
        return secondMetrics
      }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    const { rerender } = render(<RecoveryCenterPanel {...baseProps} />)
    expect(await screen.findByText(/Org A metrics failed/)).toBeInTheDocument()

    activeOrgId = 'org-b'
    rerender(<RecoveryCenterPanel {...baseProps} />)
    expect(screen.queryByText(/Org A metrics failed/)).not.toBeInTheDocument()

    releaseSecondMetrics?.(baseMetrics)
    await waitFor(() => expect(metricsCalls).toBe(2))
  })

  it('keeps a fresh-workspace dismissal session-only', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, terminalRuns: 0 }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    fireEvent.click(await screen.findByTestId('recovery-flow-demo-dismiss'))

    expect(dismissRecoveryIntroThisSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem('janusly:recovery:hideIntro')).toBeNull()
  })

  it('keeps the durable dismissal after real terminal history', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    fireEvent.click(await screen.findByTestId('recovery-flow-demo-dismiss'))

    expect(localStorage.getItem('janusly:recovery:hideIntro')).toBe('true')
  })

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
    expect(await screen.findByText('Missing secret: GITHUB_TOKEN')).toBeInTheDocument()
    expect(screen.getByText('Approve invoice')).toBeInTheDocument()
    // SLA attainment metric tile renders from metrics.slaAttainment. Assert on
    // the label + stable testId, not the display value — the count-up animation
    // means the numeric text isn't settled synchronously in jsdom.
    expect(screen.getByText('SLA attainment')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-sla')).toBeInTheDocument()
  })

  it('hands Open queue to the focused recovery navigation callback', async () => {
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
    expect(baseProps.onOpenRecoveryQueue).toHaveBeenCalledOnce()
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
    // openRun now switches to the runs tab itself (before its fetch resolves),
    // so the row passes the target tab through instead of a separate onOpenTab.
    expect(baseProps.onOpenRun).toHaveBeenCalledWith('run-1', 'runs')
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
    expect(baseProps.onOpenRecoveryQueue).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('recovery-center-metric-mttr'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
    fireEvent.click(screen.getByTestId('recovery-center-metric-approvals'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('runs')
    fireEvent.click(screen.getByTestId('recovery-center-metric-replay'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
  })

  it('drills an MTTR sparkline point into the matching recovery day', async () => {
    const trend = [
      { day: '2026-07-01', seconds: 300 },
      { day: '2026-07-02', seconds: 240 },
      { day: '2026-07-03', seconds: 180 },
    ]
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, mttrTrend: trend }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} runs={populatedRuns as never} />)
    fireEvent.click(await screen.findByTestId('vitals-sparkline-point-1'))

    expect(baseProps.onOpenTab).toHaveBeenCalledWith('runs')
    expect(consumeRecoveryFocusDay()).toBe('2026-07-02')
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
      // With open failures the hero leads with the action title and demotes
      // the personalized greeting to the subline — assert the name still
      // renders somewhere in the hero, not specifically in the h1.
      const hero = screen.getByTestId('recovery-center-greeting').closest('header')
      expect(hero?.textContent).toMatch(/jane/i)
    })
  })

  it('surfaces the longest open downtime and a real clean streak', async () => {
    const dayMs = 86_400_000
    const todayMs = Date.now()
    const recoveryDays = [2, 1, 0].map((daysAgo) => ({
      day: new Date(todayMs - daysAgo * dayMs).toISOString().slice(0, 10),
      failures: 1,
      recovered: 1,
    }))
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') {
        return { days: recoveryDays }
      }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    const oldFailure = {
      ...populatedDlq[0],
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    }

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[oldFailure] as never} />)

    const downtime = await screen.findByTestId('recovery-center-longest-downtime')
    expect(downtime).toHaveTextContent(/5h/)
    expect(downtime).toHaveAttribute('data-severity', 'danger')
    expect(await screen.findByTestId('recovery-center-clean-streak')).toHaveTextContent('3-day clean streak')
  })

  it('uses the org-wide count and oldest queue row instead of the capped bootstrap page', async () => {
    const oldest = {
      ...populatedDlq[0],
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    }
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/dlq/counts') return { total: 150, open: 1, replayed: 149, resolved: 0 }
      if (path === '/dlq/queue?status=open&sort=oldest&limit=1') {
        return { items: [oldest], nextCursor: null, hasMore: false }
      }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    expect(await screen.findByTestId('recovery-center-greeting')).toHaveTextContent('1 run needs recovery')
    const downtime = await screen.findByTestId('recovery-center-longest-downtime')
    expect(downtime).toHaveTextContent(/5h/)
    expect(downtime).toHaveAttribute('data-severity', 'danger')
  })

  it('does not invent a clean streak for a workspace without heatmap activity', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    await screen.findByTestId('recovery-flow-demo')
    expect(screen.queryByTestId('recovery-center-clean-streak')).toBeNull()
  })
})

describe('<RecoveryCenterPanel /> — all-clear moment', () => {
  function mockAllClearApis() {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, downtimeEndedMs: 7_200_000 }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
  }

  it('celebrates one in-session transition from an open failure to an empty queue', async () => {
    mockAllClearApis()
    const failure = {
      id: 'dlq-last', runId: 'run-last', nodeId: 'charge', attempt: 1, status: 'open' as const,
      workflowJson: {}, nodeJson: {}, errorJson: {}, createdAt: new Date().toISOString(),
    }
    const { rerender } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[failure] as never} />)
    await screen.findByTestId('recovery-center-longest-downtime')

    vi.useFakeTimers()
    try {
      await act(async () => {
        rerender(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
      })

      expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/)
      expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('2h of downtime ended')
      expect(screen.getByTestId('celebration-burst')).toBeInTheDocument()

      act(() => { vi.advanceTimersByTime(30_000) })
      expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
      expect(screen.queryByTestId('celebration-burst')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never celebrates an initially empty workspace', async () => {
    mockAllClearApis()

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    await screen.findByTestId('recovery-flow-demo')
    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('consumes the transient Runs-to-Home handoff once and prefers its downtime', async () => {
    mockAllClearApis()
    requestRecoveryAllClear({ downtimeMs: 3_660_000 })

    const { unmount } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    await waitFor(() => expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/))
    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('1h 1m of downtime ended')
    unmount()

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
    await screen.findByTestId('recovery-flow-demo')
    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
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
