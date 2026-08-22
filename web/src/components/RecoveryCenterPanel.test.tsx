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
  countActiveRecoveryBlockers,
  computeRecommendedActions,
  humanizeAge,
  listActiveRuns,
  readErrorSignature,
  type RecommendedActionSignals,
} from './recovery-center/recovery-center-model'

vi.mock('../api', () => ({ api: vi.fn() }))

const bumpPlatformVersion = vi.fn()
const addToast = vi.fn()
const dismissRecoveryIntroThisSession = vi.fn()
let activeOrgId: string | null = 'default'
let activeUserId: string | null = 'dev-user'
let platformVersion = 0

vi.mock('../store', () => ({
  useWorkflowStore: (
    selector: (state: {
      bumpPlatformVersion: () => void
      addToast: typeof addToast
      user: unknown
      platformVersion: number
      orgId: string | null
      userId: string | null
      recoveryIntroDismissedThisSession: boolean
      dismissRecoveryIntroThisSession: typeof dismissRecoveryIntroThisSession
    }) => unknown,
  ) => selector({
    bumpPlatformVersion,
    addToast,
    user: { email: 'jane@example.com' },
    platformVersion,
    orgId: activeOrgId,
    userId: activeUserId,
    recoveryIntroDismissedThisSession: false,
    dismissRecoveryIntroThisSession,
  }),
}))

const baseProps = {
  runs: [],
  runNodes: [],
  deadLetters: [],
  onOpenTab: vi.fn(),
  onOpenRecoveryCase: vi.fn(),
  onOpenRun: vi.fn(),
  onOpenRecoveryQueue: vi.fn(),
}

const baseMetrics = {
  successRate: { value: 87, display: '87%', severity: 'healthy', rationale: 'Workflow success rate' },
  verifiedRecovery: {
    value: 7 * 60_000,
    display: '7m',
    severity: 'warn',
    rationale: 'Verified recovery median',
    rationaleCode: 'verified_recovery.summary',
    rationaleMeta: { count: 3, p50: '7m', p90: '12m' },
    definitionVersion: '1',
    metric: 'time_to_verified_recovery',
    unit: 'milliseconds',
    sampleSize: 3,
    p50Ms: 7 * 60_000,
    p90Ms: 12 * 60_000,
  },
  mttr: { value: 12, display: '12m', severity: 'warn', rationale: 'Legacy mean time to recovery' },
  p95Latency: { value: 240, display: '240ms', severity: 'healthy', rationale: 'p95 latency' },
  approvalsPending: { value: 0, display: '0', severity: 'healthy', rationale: 'No human action waiting' },
  replayRate: { value: 78, display: '78%', severity: 'healthy', rationale: 'Replay success rate' },
  slaAttainment: { value: 92, display: '92.0%', severity: 'healthy', rationale: 'SLA attainment', rationaleCode: 'sla_attainment.summary', rationaleMeta: { metSla: 46, resolvedInWindow: 50 } },
  timeToFirstAction: { value: 480, display: '8m', severity: 'healthy', rationale: 'First action', rationaleCode: 'time_to_first_action.summary', rationaleMeta: { avg: '8m', p95: '15m', sampleSize: 4 } },
  recurrenceRate: { value: 90, display: '90.0%', severity: 'healthy', rationale: 'Fix durability', rationaleCode: 'recurrence.summary', rationaleMeta: { held: 9, resolved: 10, recurred: 1 } },
  windowDays: 30,
  terminalRuns: 87,
}

const baseClusters = { clusters: [], totalSamples: 0, windowDays: 30 }
const baseValidation = {
  generatedAt: '2026-07-21T12:00:00.000Z',
  windowDays: 30,
  sampleLimit: 100,
  sampleCapped: false,
  totals: {
    drills: 1,
    completed: 1,
    recovered: 1,
    acceptedLoss: 0,
    awaitingAction: 0,
    replayInProgress: 0,
    measurementIncomplete: 0,
    missingEvidence: 0,
    completionRatePercent: 100,
    recoveryRatePercent: 100,
  },
  resolution: { operator: 0, automated: 1, unknown: 0, operatorInterventionRatePercent: 0 },
  timing: {
    medianElapsedMs: 60_000,
    p90ElapsedMs: 60_000,
    averageElapsedMs: 60_000,
    p95ElapsedMs: 60_000,
    sampleSize: 1,
  },
  byFailureMode: [],
}

type ApiMockHandler = (
  path: string,
  options?: unknown,
) => Promise<unknown>

function mockRecoveryApi(handler: ApiMockHandler) {
  const settleValue = async (
    loader: () => Promise<unknown>,
  ): Promise<{ status: 'ok'; value: unknown } | { status: 'unavailable' }> => {
    try {
      return { status: 'ok', value: await loader() }
    } catch {
      return { status: 'unavailable' }
    }
  }
  const settle = (path: string, options?: unknown) =>
    settleValue(() => handler(path, options))
  const queue = async (options?: unknown) => {
    const counts = await handler('/dlq/counts', options) as { open?: unknown }
    const open = counts?.open
    if (typeof open !== 'number' || !Number.isInteger(open) || open < 0) {
      throw new Error('invalid queue counts')
    }
    const page = open > 0
      ? await handler('/dlq/queue?status=open&sort=oldest&limit=1', options) as { items?: unknown }
      : { items: [] }
    return {
      counts,
      oldestOpen: Array.isArray(page?.items) ? page.items[0] ?? null : null,
    }
  }

  vi.mocked(api).mockImplementation(async (path: string, options?: unknown) => {
    if (path !== '/recovery/home' && path !== '/recovery/home?scope=impact') {
      return handler(path, options)
    }
    const impact = {
      ledger: await settle('/recovery/ledger', options),
      wins: await settle('/recovery/my-wins?days=30', options),
      queue: await settleValue(() => queue(options)),
    }
    const sections = path.endsWith('scope=impact')
      ? impact
      : {
          metrics: await settle('/recovery/metrics', options),
          clusters: await settle('/dlq/clusters', options),
          heatmap: await settle('/recovery/heatmap?days=90', options),
          validation: await settle('/recovery/validation?windowDays=30', options),
          cases: await settle('/recovery/cases?limit=50', options),
          ...impact,
        }
    return {
      scope: path.endsWith('scope=impact') ? 'impact' : 'full',
      generatedAt: '2026-07-28T00:00:00.000Z',
      sections,
    }
  })
}

beforeEach(() => {
  consumeRecoveryAllClear()
  consumeRecoveryFocusDay()
  vi.mocked(api).mockReset()
  bumpPlatformVersion.mockReset()
  addToast.mockReset()
  dismissRecoveryIntroThisSession.mockReset()
  activeOrgId = 'default'
  activeUserId = 'dev-user'
  platformVersion = 0
  localStorage.removeItem('janusly:recovery:hideIntro')
  baseProps.onOpenTab = vi.fn()
  baseProps.onOpenRun = vi.fn()
  baseProps.onOpenRecoveryQueue = vi.fn()
})

async function openHomeInsights() {
  fireEvent.click(screen.getByTestId('home-insights-toggle'))
  await screen.findByTestId('home-insights-content')
}

describe('countActiveRecoveryBlockers', () => {
  it('counts semantic quarantine from the run projection even when every node is terminal', () => {
    expect(countActiveRecoveryBlockers([
      {
        id: 'run-semantic',
        status: 'waiting',
        outcomeStatus: 'semantic_quarantined',
      },
    ], [
      { nodeId: 'answer', status: 'succeeded' },
    ], 'run-semantic')).toBe(1)
  })

  it('uses the selected node fallback without double-counting a projected run', () => {
    const waitingNode = [{ nodeId: 'approval', status: 'waiting' }]
    expect(countActiveRecoveryBlockers([], waitingNode, 'run-selected')).toBe(1)
    expect(countActiveRecoveryBlockers([
      { id: 'run-selected', status: 'waiting' },
    ], waitingNode, 'run-selected')).toBe(1)
  })

  it('merges semantic case ids without double-counting the run projection', () => {
    expect(countActiveRecoveryBlockers([
      { id: 'run-semantic', status: 'waiting' },
    ], [], null, ['run-semantic', 'run-other'])).toBe(2)
  })
})

describe('listActiveRuns', () => {
  it('keeps only canonical open statuses, newest first, and respects the limit', () => {
    const runs = [
      { id: 'old-running', status: 'running', createdAt: '2026-07-28T10:00:00.000Z' },
      { id: 'done', status: 'succeeded', createdAt: '2026-07-28T14:00:00.000Z' },
      { id: 'new-waiting', status: 'waiting', createdAt: '2026-07-28T13:00:00.000Z' },
      { id: 'created', status: 'created', createdAt: '2026-07-28T12:00:00.000Z' },
      { id: 'stale-paused', status: 'paused', createdAt: '2026-07-28T15:00:00.000Z' },
    ]

    expect(listActiveRuns(runs, 2).map((run) => run.id)).toEqual([
      'new-waiting',
      'created',
    ])
  })

  it('returns no rows for a non-positive limit', () => {
    expect(listActiveRuns([{ id: 'running', status: 'running' }], 0)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// computeRecommendedActions — bounded operational priority fixtures
// ─────────────────────────────────────────────────────────────────────────

describe('computeRecommendedActions', () => {
  const signals = (
    overrides: Partial<RecommendedActionSignals>,
  ): RecommendedActionSignals => ({
    openFailures: 0,
    pendingApprovals: 0,
    semanticCases: 0,
    topClusterFrequency: 0,
    healthScore: 95,
    ...overrides,
  })

  it('prioritizes pending approvals first when waiting nodes > 0', () => {
    const actions = computeRecommendedActions(signals({
      openFailures: 5,
      pendingApprovals: 2,
      topClusterFrequency: 4,
      healthScore: 55,
    }))
    expect(actions[0]!.id).toBe('resolve_approvals')
    expect(actions[0]!.severity).toBe('warning')
    expect(actions[0]!.ctaTab).toBe('recover')
    expect(actions[0]!.title).toContain('Resolve 2 approval')
  })

  it('surfaces declared business-outcome incidents before diagnostic work', () => {
    const actions = computeRecommendedActions(signals({
      semanticCases: 2,
      topClusterFrequency: 4,
      healthScore: 55,
    }))
    expect(actions[0]!.id).toBe('review_semantic_cases')
    expect(actions[0]!.severity).toBe('danger')
    expect(actions[0]!.title).toContain('2 business outcome incidents')
  })

  it('falls through to recover_cluster when no approvals but a frequency-≥2 cluster exists', () => {
    const actions = computeRecommendedActions(signals({
      openFailures: 5,
      topClusterFrequency: 4,
      healthScore: 90,
    }))
    expect(actions[0]!.id).toBe('recover_cluster')
    expect(actions[0]!.severity).toBe('cobalt')
    expect(actions[0]!.ctaTab).toBe('recover')
    expect(actions[0]!.title).toContain('Recover all 4')
    expect(actions.some((action) => action.id === 'triage_failures')).toBe(false)
  })

  it('falls through to triage_failures when no approvals and no qualifying cluster', () => {
    const actions = computeRecommendedActions(signals({
      openFailures: 3,
      topClusterFrequency: 1,
      healthScore: 90,
    }))
    expect(actions[0]!.id).toBe('triage_failures')
    expect(actions[0]!.severity).toBe('warning')
    expect(actions[0]!.title).toBe('Triage Recovery Queue · Open: 3')
  })

  it('flags review_workflow_risk with severity danger when health < 60', () => {
    const actions = computeRecommendedActions(signals({
      healthScore: 45,
    }))
    expect(actions[0]!.id).toBe('review_workflow_risk')
    expect(actions[0]!.severity).toBe('danger')
  })

  it('flags review_workflow_risk with severity warning when health 60-79', () => {
    const actions = computeRecommendedActions(signals({
      healthScore: 72,
    }))
    expect(actions[0]!.id).toBe('review_workflow_risk')
    expect(actions[0]!.severity).toBe('warning')
  })

  it('caps the priority inbox at three actions', () => {
    const actions = computeRecommendedActions(signals({
      openFailures: 5,
      pendingApprovals: 2,
      semanticCases: 1,
      topClusterFrequency: 4,
      healthScore: 45,
    }))
    expect(actions.map((action) => action.id)).toEqual([
      'resolve_approvals',
      'review_semantic_cases',
      'recover_cluster',
    ])
  })

  it('returns no artificial task when every operational signal is clean', () => {
    expect(computeRecommendedActions(signals({}))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// buildGreeting — time-of-day + posture
// ─────────────────────────────────────────────────────────────────────────

describe('buildGreeting', () => {
  const semanticClear = {
    semanticOutcomePosture: 'clear' as const,
    semanticCaseCount: 0,
  }

  it('says "Good morning" before noon', () => {
    const g = buildGreeting({ hour: 9, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10, ...semanticClear })
    expect(g.salutation).toBe('Good morning, Jane.')
  })
  it('says "Good afternoon" 12-17', () => {
    const g = buildGreeting({ hour: 14, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10, ...semanticClear })
    expect(g.salutation).toBe('Good afternoon, Jane.')
  })
  it('says "Good evening" after 18', () => {
    const g = buildGreeting({ hour: 20, displayName: 'Jane', openFailures: 0, pendingApprovals: 0, healthScore: 95, totalRuns: 10, ...semanticClear })
    expect(g.salutation).toBe('Good evening, Jane.')
  })
  it('drops the name filler when displayName is null', () => {
    // Operator with no resolvable name reads cleaner as "Good morning."
    // than "Good morning, there." — the former feels intentional, the
    // latter feels like a stale placeholder.
    const g = buildGreeting({ hour: 9, displayName: null, openFailures: 0, pendingApprovals: 0, healthScore: null, totalRuns: 0, ...semanticClear })
    expect(g.salutation).toBe('Good morning.')
  })
  it('subline reflects approvals waiting', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 3, pendingApprovals: 2, healthScore: 80, totalRuns: 50, ...semanticClear })
    expect(g.subline).toContain('2 approval')
  })
  it('subline reflects open failures when no approvals', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 3, pendingApprovals: 0, healthScore: 80, totalRuns: 50, ...semanticClear })
    expect(g.subline).toContain('3 run')
  })
  it('subline celebrates when health ≥ 80 and no signals', () => {
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 0, pendingApprovals: 0, healthScore: 96, totalRuns: 50, ...semanticClear })
    expect(g.subline).toContain('All clear')
  })
  it('prioritizes known semantic incidents over clean health signals', () => {
    const g = buildGreeting({
      hour: 9,
      displayName: 'J',
      openFailures: 0,
      pendingApprovals: 0,
      healthScore: 96,
      totalRuns: 50,
      semanticOutcomePosture: 'attention',
      semanticCaseCount: 2,
    })
    expect(g.subline).toContain('2 business outcome incidents need review')
  })
  it('does not claim a clean posture while semantic outcomes are unavailable', () => {
    const g = buildGreeting({
      hour: 9,
      displayName: 'J',
      openFailures: 0,
      pendingApprovals: 0,
      healthScore: 96,
      totalRuns: 50,
      semanticOutcomePosture: 'unavailable',
      semanticCaseCount: 0,
    })
    expect(g.subline).toContain('could not be confirmed')
    expect(g.subline).not.toContain('All clear')
  })
  it('subline falls to the clean-posture line when no runs yet (the pitch carries the welcome)', () => {
    // The hero pitch right below the greeting already explains what
    // Janusly does — duplicating that with a "Welcome to Janusly" subline
    // wastes attention. New-operator subline now matches the steady-state
    // clean posture: "Recovery posture is clean across the last 30 days."
    const g = buildGreeting({ hour: 9, displayName: 'J', openFailures: 0, pendingApprovals: 0, healthScore: null, totalRuns: 0, ...semanticClear })
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
  it('loads the coordinated Home snapshot through one recovery request', async () => {
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
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return readyClusters
      if (path === '/recovery/heatmap?days=90') return pendingHeatmap
      if (path === '/recovery/validation?windowDays=30') return baseValidation
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    expect(vi.mocked(api)).toHaveBeenCalledWith('/recovery/home')
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/recovery/metrics')
    await openHomeInsights()
    expect(screen.getByTestId('recovery-center-metric-verified-recovery'))
      .not.toHaveTextContent('7m')
    await act(async () => {
      releaseHeatmap?.({ days: [] })
      await pendingHeatmap
    })
    await waitFor(() => {
      expect(screen.getByTestId('recovery-center-metric-verified-recovery')).toHaveTextContent('7m')
      expect(screen.getByText('Slow heatmap cluster')).toBeInTheDocument()
      expect(screen.getByTestId('recovery-validation-section')).toHaveTextContent('1/1')
    })
  })

  it('keeps healthy Home sections visible when one wire section is malformed', async () => {
    const healthyClusters = {
      clusters: [{
        signature: 'http:rate-limit',
        category: 'http_error' as const,
        frequency: 2,
        suggestedOwner: 'ops' as const,
        lastSeen: '2026-07-27T12:00:00.000Z',
      }],
      totalSamples: 2,
      windowDays: 30,
    }
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') {
        return {
          ...baseMetrics,
          replayRate: { ...baseMetrics.replayRate, display: 42 },
        }
      }
      if (path === '/dlq/clusters') return healthyClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/validation?windowDays=30') return baseValidation
      if (path === '/recovery/cases?limit=50') return { cases: [] }
      if (path === '/recovery/ledger') {
        return {
          totalRecovered: 0,
          downtimeEndedMs: 0,
          sinceIso: null,
        }
      }
      if (path === '/recovery/my-wins?days=30') {
        return { recovered: 0, windowDays: 30 }
      }
      if (path === '/dlq/counts') return { open: 0 }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return {
          allowed: true,
          monthlyUsdSpent: 0,
          monthlyUsdLimit: null,
          policy: 'warn',
        }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()

    expect(await screen.findByText('http:rate-limit')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-validation-section'))
      .toHaveTextContent('1/1')
    expect(screen.getByTestId('recovery-center-metric-verified-recovery'))
      .not.toHaveTextContent('7m')
  })

  it('waits for terminal-run history before exposing the walkthrough dismissal', async () => {
    let releaseMetrics: ((value: unknown) => void) | undefined
    const pendingMetrics = new Promise((resolve) => { releaseMetrics = resolve })
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return pendingMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    expect(screen.queryByTestId('recovery-lab-entry')).not.toBeInTheDocument()

    releaseMetrics?.({ ...baseMetrics, terminalRuns: 0 })
    expect(await screen.findByTestId('recovery-lab-entry')).toBeInTheDocument()
  })

  it('does not render a previous organization snapshot during an org switch', async () => {
    let releaseFirstMetrics: ((value: unknown) => void) | undefined
    const firstMetrics = new Promise((resolve) => { releaseFirstMetrics = resolve })
    let metricsCalls = 0
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') {
        metricsCalls += 1
        if (metricsCalls === 1) return firstMetrics
        return {
          ...baseMetrics,
          verifiedRecovery: {
            ...baseMetrics.verifiedRecovery,
            value: 22 * 60_000,
            display: '22m',
          },
        }
      }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    const { rerender } = render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    await waitFor(() => expect(metricsCalls).toBe(1))
    activeOrgId = 'org-b'
    rerender(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    await waitFor(() => {
      expect(metricsCalls).toBe(2)
      expect(screen.getByTestId('recovery-center-metric-verified-recovery')).toHaveTextContent('22m')
    })

    releaseFirstMetrics?.({
      ...baseMetrics,
      verifiedRecovery: {
        ...baseMetrics.verifiedRecovery,
        value: 99 * 60_000,
        display: '99m',
      },
    })
    await Promise.resolve()
    expect(screen.getByTestId('recovery-center-metric-verified-recovery')).not.toHaveTextContent('99m')
  })

  it('does not render a previous organization metrics error during an org switch', async () => {
    let releaseSecondMetrics: ((value: unknown) => void) | undefined
    const secondMetrics = new Promise((resolve) => { releaseSecondMetrics = resolve })
    let metricsCalls = 0
    mockRecoveryApi(async (path: string) => {
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
    await openHomeInsights()
    expect(await screen.findByText(/Metrics unavailable/i)).toBeInTheDocument()

    activeOrgId = 'org-b'
    rerender(<RecoveryCenterPanel {...baseProps} />)
    expect(screen.queryByText(/Metrics unavailable/i)).not.toBeInTheDocument()

    releaseSecondMetrics?.(baseMetrics)
    await waitFor(() => expect(metricsCalls).toBe(2))
  })

  it('keeps a fresh-workspace dismissal session-only', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, terminalRuns: 0 }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    fireEvent.click(await screen.findByTestId('recovery-lab-entry-dismiss'))

    expect(dismissRecoveryIntroThisSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem('janusly:recovery:hideIntro')).toBeNull()
  })

  it('keeps the durable dismissal after real terminal history', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    fireEvent.click(await screen.findByTestId('recovery-lab-entry-dismiss'))

    expect(localStorage.getItem('janusly:recovery:hideIntro')).toBe('true')
  })

  it('renders the welcome hero when no runs / no DLQ / no waiting nodes', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()

    await waitFor(() => {
      expect(screen.getByTestId('recovery-lab-entry')).toBeInTheDocument()
    })
    expect(screen.getByText('Create your first recovery evidence.')).toBeInTheDocument()
    expect(screen.getByText(/no incidents or sample activity/i)).toBeInTheDocument()
    expect(screen.queryByText(/0x9af2|stripe\.charge|412ms|92 AI/)).toBeNull()
    expect(screen.getByTestId('recovery-center-empty-cta-studio')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-empty-cta-recipes')).toBeInTheDocument()
  })

  it('opens AI Studio when the empty-state Studio CTA is clicked', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    await waitFor(() => expect(screen.getByTestId('recovery-lab-entry')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-studio'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('ai-studio')
  })

  it('opens Recipes when the empty-state Recipes CTA is clicked', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()
    await waitFor(() => expect(screen.getByTestId('recovery-lab-entry')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-recipes'))
    expect(baseProps.onOpenTab).toHaveBeenCalledWith('templates')
  })
})

describe('<RecoveryCenterPanel /> — recovery impact', () => {
  function mockImpactReads(options: { ledgerFails?: boolean; winsFails?: boolean } = {}) {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/ledger') {
        if (options.ledgerFails) throw new Error('ledger unavailable')
        return { totalRecovered: 12, downtimeEndedMs: 11_700_000, sinceIso: '2026-01-01T00:00:00.000Z' }
      }
      if (path === '/recovery/my-wins?days=30') {
        if (options.winsFails) throw new Error('wins unavailable')
        return { recovered: 3, windowDays: 30 }
      }
      if (path === '/dlq/counts') return { open: 0 }
      if (path.startsWith('/dlq/queue?')) return { items: [] }
      if (path === '/recovery/calibration-status') {
        return { enabled: false, windowDays: 30, minimumSampleSize: 20, calibrations: [] }
      }
      if (path === '/onboarding') return { status: 'completed' }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
  }

  it('renders lifetime organization value and the authenticated operator wins', async () => {
    mockImpactReads()
    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()

    expect(await screen.findByTestId('recovery-lifetime-ledger')).toHaveTextContent(
      'Since day one: 12 failures recovered · 3h 15m of downtime ended',
    )
    expect(screen.getByTestId('recovery-center-personal-wins')).toHaveTextContent(
      'You recovered 3 failures in the last 30 days',
    )
  })

  it('keeps personal wins visible when the lifetime ledger fails independently', async () => {
    mockImpactReads({ ledgerFails: true })
    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()

    expect(await screen.findByTestId('recovery-center-personal-wins')).toBeInTheDocument()
    expect(screen.queryByTestId('recovery-lifetime-ledger')).not.toBeInTheDocument()
  })

  it('keeps lifetime value visible when personal wins fail independently', async () => {
    mockImpactReads({ winsFails: true })
    render(<RecoveryCenterPanel {...baseProps} />)
    await openHomeInsights()

    expect(await screen.findByTestId('recovery-lifetime-ledger')).toBeInTheDocument()
    expect(screen.queryByTestId('recovery-center-personal-wins')).not.toBeInTheDocument()
  })

  it('never accepts a late personal-wins snapshot from the previous user', async () => {
    let releaseFirstWins: ((value: unknown) => void) | undefined
    const firstWins = new Promise((resolve) => { releaseFirstWins = resolve })
    let winsCalls = 0
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/ledger') return { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
      if (path === '/recovery/my-wins?days=30') {
        winsCalls += 1
        return winsCalls === 1 ? firstWins : { recovered: 4, windowDays: 30 }
      }
      if (path === '/dlq/counts') return { open: 0 }
      if (path.startsWith('/dlq/queue?')) return { items: [] }
      if (path === '/recovery/calibration-status') return { enabled: false, calibrations: [] }
      if (path === '/onboarding') return { status: 'completed' }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) return { allowed: true }
      throw new Error(`unexpected fetch: ${path}`)
    })

    const { rerender } = render(<RecoveryCenterPanel {...baseProps} />)
    await waitFor(() => expect(winsCalls).toBe(1))
    activeUserId = 'user-b'
    rerender(<RecoveryCenterPanel {...baseProps} />)

    await waitFor(() => {
      expect(winsCalls).toBe(2)
      expect(screen.getByTestId('recovery-center-personal-wins')).toHaveTextContent(
        'You recovered 4 failures in the last 30 days',
      )
    })
    releaseFirstWins?.({ recovered: 99, windowDays: 30 })
    await Promise.resolve()
    expect(screen.getByTestId('recovery-center-personal-wins')).not.toHaveTextContent('99')
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
      { signature: 'Missing secret: GITHUB_TOKEN', category: 'secret_missing' as const, frequency: 3, suggestedOwner: 'ops' as const, lastSeen: new Date().toISOString(), recurredAfterRecovery: true },
    ],
    totalSamples: 5,
    windowDays: 30,
  }

  it('keeps priority work above the fold and diagnostics behind one disclosure', async () => {
    mockRecoveryApi(async (path: string) => {
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

    expect(await screen.findByTestId('home-priority-inbox')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-action-resolve_approvals')).toBeInTheDocument()
    expect(await screen.findByTestId('recovery-center-action-recover_cluster')).toBeInTheDocument()
    expect(screen.queryByTestId('recovery-center-metric-strip')).not.toBeInTheDocument()

    await openHomeInsights()
    expect(await screen.findByText('Missing secret: GITHUB_TOKEN')).toBeInTheDocument()
    // SLA attainment metric tile renders from metrics.slaAttainment. Assert on
    // the label + stable testId, not the display value — the count-up animation
    // means the numeric text isn't settled synchronously in jsdom.
    expect(screen.getByText('SLA attainment')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-sla')).toBeInTheDocument()
    expect(screen.getByText('Time to first action')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-first-action')).toBeInTheDocument()
    expect(screen.getByText('Fixes that held')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-center-metric-durability')).toBeInTheDocument()
    expect(screen.getByText('Re-failed after fix')).toBeInTheDocument()
  })

  it('opens the exact oldest visible failure from the priority inbox', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
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
    const cta = await screen.findByTestId('recovery-center-action-cta-triage_failures')
    fireEvent.click(cta)
    expect(baseProps.onOpenRecoveryQueue).toHaveBeenCalledWith('dlq-1')
  })

  it('routes clustered recovery work to the recovery queue', async () => {
    mockRecoveryApi(async (path: string) => {
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
    fireEvent.click(await screen.findByTestId('recovery-center-action-cta-recover_cluster'))
    // The recovery queue is where a cluster can actually be acted on; the
    // Settings copy of the card is read-only. Handing over the first open
    // dead letter lands the operator on the row, not just the destination.
    expect(baseProps.onOpenRecoveryQueue).toHaveBeenCalled()
    expect(baseProps.onOpenTab).not.toHaveBeenCalledWith('operations')
  })

  it('opens an active workflow directly in Activity', async () => {
    const activeRun = {
      id: 'run-active',
      status: 'running',
      workflowId: 'workflow-active',
      workflowName: 'Invoice monitor',
      createdAt: '2026-07-28T12:00:00.000Z',
    }
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={[...populatedRuns, activeRun] as never}
      runNodes={[]}
      deadLetters={populatedDlq as never}
    />)
    const row = await screen.findByTestId('home-active-run-run-active')
    expect(row).toHaveTextContent('Invoice monitor')
    fireEvent.click(row)
    expect(baseProps.onOpenRun).toHaveBeenCalledWith('run-active', 'runs')
  })

  it('clicking a metric strip cell routes to the expected detail tab', async () => {
    mockRecoveryApi(async (path: string) => {
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
    await openHomeInsights()
    await waitFor(() => expect(screen.getByTestId('recovery-center-metric-failures')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-metric-failures'))
    expect(baseProps.onOpenRecoveryQueue).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('recovery-center-metric-verified-recovery'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
    fireEvent.click(screen.getByTestId('recovery-center-metric-approvals'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('runs')
    fireEvent.click(screen.getByTestId('recovery-center-metric-replay'))
    expect(baseProps.onOpenTab).toHaveBeenLastCalledWith('operations')
  })

  it('drills a verified-recovery trend point into the matching recovery day', async () => {
    const trend = [
      { day: '2026-07-01', seconds: 300 },
      { day: '2026-07-02', seconds: 240 },
      { day: '2026-07-03', seconds: 180 },
    ]
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, mttrTrend: trend }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} runs={populatedRuns as never} />)
    await openHomeInsights()
    fireEvent.click(await screen.findByTestId('vitals-sparkline-point-1'))

    expect(baseProps.onOpenTab).toHaveBeenCalledWith('recover')
    expect(consumeRecoveryFocusDay()).toBe('2026-07-02')
  })

  it('leads with approval work and opens the exact waiting run', async () => {
    const waitingRun = {
      id: 'run-waiting',
      status: 'waiting',
      hasWaitingNodes: true,
      workflowName: 'Approval workflow',
      createdAt: '2026-07-28T13:00:00.000Z',
    }
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return populatedClusters
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: null }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    render(<RecoveryCenterPanel
      {...baseProps}
      runs={[...populatedRuns, waitingRun] as never}
      runNodes={populatedNodes as never}
      deadLetters={populatedDlq as never}
    />)
    await waitFor(() => expect(screen.getByTestId('recovery-center-action-resolve_approvals')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('recovery-center-action-cta-resolve_approvals'))
    expect(baseProps.onOpenRun).toHaveBeenCalledWith('run-waiting', 'runs')
  })

  it('renders the Recovery Center-greeting header with the user display name', async () => {
    mockRecoveryApi(async (path: string) => {
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
      mttrSeconds: 0,
    }))
    mockRecoveryApi(async (path: string) => {
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
    mockRecoveryApi(async (path: string) => {
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

    await waitFor(() => {
      expect(screen.getByTestId('recovery-center-action-triage_failures'))
        .toHaveTextContent('Triage Recovery Queue · Open: 1')
    })
    const downtime = await screen.findByTestId('recovery-center-longest-downtime')
    expect(downtime).toHaveTextContent(/5h/)
    expect(downtime).toHaveAttribute('data-severity', 'danger')
  })

  it('does not invent a clean streak for a workspace without heatmap activity', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    await openHomeInsights()
    await screen.findByTestId('recovery-lab-entry')
    expect(screen.queryByTestId('recovery-center-clean-streak')).toBeNull()
  })
})

describe('<RecoveryCenterPanel /> — semantic outcome incidents', () => {
  it('surfaces semantic work as a priority and opens the exact case', async () => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/validation?windowDays=30') return baseValidation
      if (path === '/recovery/cases?limit=50') {
        return {
          cases: [
            {
              id: 'case-1',
              orgId: 'default',
              runId: 'run-1',
              workflowId: 'workflow-1',
              workflowVersionId: 'version-1',
              source: 'semantic_violation',
              detectorId: 'ai-mode',
              sourceNodeId: 'answer',
              detectorKind: 'expression',
              action: 'quarantine',
              message: 'AI output is required',
              detailsJson: ['$.mode must equal "ai"'],
              state: 'contained',
              createdBy: 'dev-user',
              createdAt: '2026-07-27T12:00:00.000Z',
              updatedAt: '2026-07-27T12:00:00.000Z',
              resolvedAt: null,
            },
            {
              id: 'case-2',
              orgId: 'default',
              runId: 'run-2',
              workflowId: 'workflow-2',
              workflowVersionId: 'version-2',
              source: 'semantic_violation',
              detectorId: 'review-note',
              sourceNodeId: 'review',
              detectorKind: 'schema',
              action: 'observe',
              message: 'Review note is missing',
              detailsJson: ['$.note is required'],
              state: 'detected',
              createdBy: 'dev-user',
              createdAt: '2026-07-27T11:00:00.000Z',
              updatedAt: '2026-07-27T11:00:00.000Z',
              resolvedAt: null,
            },
          ],
        }
      }
      if (path === '/recovery/ledger') return null
      if (path === '/recovery/my-wins?days=30') return { recovered: 0, windowDays: 30 }
      if (path.startsWith('/dlq/counts')) return { open: 0 }
      if (path.startsWith('/dlq/queue')) return { items: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      if (path === '/recovery/calibration-status') {
        return { enabled: true, windowDays: 30, minimumSampleSize: 20, calibrations: [] }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    const action = await screen.findByTestId('recovery-center-action-review_semantic_cases')
    expect(action).toHaveTextContent('2 business outcome incidents')
    expect(screen.getByText('2 business outcome incidents need review.')).toBeVisible()
    expect(screen.getByTestId('recovery-center-greeting').closest('header'))
      .not.toHaveAttribute('data-all-clear')
    fireEvent.click(screen.getByTestId('recovery-center-action-cta-review_semantic_cases'))
    expect(baseProps.onOpenRecoveryCase).toHaveBeenCalledWith('case-1')
    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining('/resolve'),
      expect.anything(),
    )
  })

  it.each([
    ['request failure', new Error('semantic projection unavailable')],
    ['invalid success payload', {}],
  ])('does not present an all-clear state after a semantic %s', async (_label, semanticResponse) => {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/cases?limit=50') {
        if (semanticResponse instanceof Error) throw semanticResponse
        return semanticResponse
      }
      if (path === '/recovery/metrics') return baseMetrics
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/validation?windowDays=30') return baseValidation
      if (path === '/recovery/ledger') return null
      if (path === '/recovery/my-wins?days=30') return { recovered: 0, windowDays: 30 }
      if (path.startsWith('/dlq/counts')) return { open: 0 }
      if (path.startsWith('/dlq/queue')) return { items: [] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      if (path === '/recovery/calibration-status') {
        return { enabled: true, windowDays: 30, minimumSampleSize: 20, calibrations: [] }
      }
      return null
    })

    render(<RecoveryCenterPanel {...baseProps} />)

    expect(
      await screen.findByText(/Business outcome posture could not be confirmed/i),
    ).toBeVisible()
    expect(screen.getByTestId('home-health-summary')).toHaveTextContent('Status is incomplete')
    expect(screen.getByTestId('recovery-center-greeting').closest('header'))
      .not.toHaveAttribute('data-all-clear')
    expect(screen.queryByTestId('recovery-center-action-review_semantic_cases')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(bumpPlatformVersion).toHaveBeenCalledTimes(1)
  })
})

describe('<RecoveryCenterPanel /> — all-clear moment', () => {
  let recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null as string | null }

  function mockAllClearApis() {
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, downtimeEndedMs: 7_200_000 }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/cases?limit=50') return { cases: [] }
      if (path === '/recovery/ledger') return recoveryLedger
      if (path === '/recovery/my-wins?days=30') return { recovered: 0, windowDays: 30 }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
  }

  it('does not celebrate an in-place queue transition without terminal impact evidence', async () => {
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    const failure = {
      id: 'dlq-last', runId: 'run-last', nodeId: 'charge', attempt: 1, status: 'open' as const,
      workflowJson: {}, nodeJson: {}, errorJson: {}, createdAt: new Date().toISOString(),
    }
    const { rerender } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[failure] as never} />)
    await screen.findByTestId('recovery-center-longest-downtime')

    await act(async () => {
      rerender(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
    })

    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
    expect(screen.queryByTestId('recovery-center-all-clear-summary')).toBeNull()
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('celebrates an in-place terminal ledger increase once the queue is empty', async () => {
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    const { rerender } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
    await openHomeInsights()
    await screen.findByTestId('recovery-lab-entry')
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/recovery/home'))

    recoveryLedger = {
      totalRecovered: 1,
      downtimeEndedMs: 7_200_000,
      sinceIso: '2026-07-13T12:00:00.000Z',
    }
    platformVersion = 1
    rerender(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    await waitFor(() => expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/))
    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('2h of downtime ended')
    expect(screen.getByTestId('celebration-burst')).toBeInTheDocument()
  })

  it('detects terminal impact for a background run without a platform-version bump', async () => {
    vi.useFakeTimers()
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    const view = render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(vi.mocked(api)).toHaveBeenCalledWith('/recovery/home')

      recoveryLedger = {
        totalRecovered: 1,
        downtimeEndedMs: 120_000,
        sinceIso: '2026-07-13T12:00:00.000Z',
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/)
      expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('2m of downtime ended')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('pauses fallback reads while hidden and refreshes immediately on return', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    const view = render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const impactCalls = () => vi.mocked(api).mock.calls
        .filter(([path]) => path === '/recovery/home' || path === '/recovery/home?scope=impact')
        .length
      expect(impactCalls()).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(impactCalls()).toBe(1)

      hidden.mockReturnValue(false)
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(impactCalls()).toBe(2)
    } finally {
      view.unmount()
      hidden.mockRestore()
      vi.useRealTimers()
    }
  })

  it('retires a preloaded open row when a later count verifies background recovery', async () => {
    vi.useFakeTimers()
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    let openCount = 1
    const failure = {
      id: 'dlq-preloaded', runId: 'run-preloaded', nodeId: 'charge', attempt: 1, status: 'open' as const,
      workflowJson: {}, nodeJson: {}, errorJson: {}, createdAt: new Date().toISOString(),
    }
    const deadLetters = [failure] as never
    mockRecoveryApi(async (path: string) => {
      if (path === '/recovery/metrics') return { ...baseMetrics, downtimeEndedMs: 120_000 }
      if (path === '/dlq/clusters') return baseClusters
      if (path === '/recovery/heatmap?days=90') return { days: [] }
      if (path === '/recovery/cases?limit=50') return { cases: [] }
      if (path === '/recovery/ledger') return recoveryLedger
      if (path === '/recovery/my-wins?days=30') return { recovered: recoveryLedger.totalRecovered, windowDays: 30 }
      if (path === '/dlq/counts') return { open: openCount }
      if (path === '/dlq/queue?status=open&sort=oldest&limit=1') return { items: [failure] }
      if (path === '/billing/budget' || path.startsWith('/billing/budget?')) {
        return { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn' }
      }
      throw new Error(`unexpected fetch: ${path}`)
    })
    const view = render(<RecoveryCenterPanel {...baseProps} deadLetters={deadLetters} />)

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(vi.mocked(api)).toHaveBeenCalledWith('/recovery/home')

      recoveryLedger = {
        totalRecovered: 1,
        downtimeEndedMs: 120_000,
        sinceIso: '2026-07-13T12:00:00.000Z',
      }
      openCount = 0
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })

      expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/)
      expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('2m of downtime ended')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('buffers terminal evidence when the ledger settles before the queue-empty snapshot', async () => {
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    const failure = {
      id: 'dlq-last', runId: 'run-last', nodeId: 'charge', attempt: 1, status: 'open' as const,
      workflowJson: {}, nodeJson: {}, errorJson: {}, createdAt: new Date().toISOString(),
    }
    const { rerender } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[failure] as never} />)
    await openHomeInsights()
    await screen.findByTestId('recovery-center-longest-downtime')

    recoveryLedger = {
      totalRecovered: 1,
      downtimeEndedMs: 90_000,
      sinceIso: '2026-07-13T12:00:00.000Z',
    }
    platformVersion = 1
    rerender(<RecoveryCenterPanel {...baseProps} deadLetters={[failure] as never} />)
    await waitFor(
      () => expect(screen.getByTestId('recovery-lifetime-ledger')).toHaveTextContent('1 failure recovered'),
      { timeout: 5_000 },
    )
    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)

    rerender(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
    await waitFor(
      () => expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/),
      { timeout: 5_000 },
    )
    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('1m of downtime ended')
  })

  it('never celebrates an initially empty workspace', async () => {
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    await openHomeInsights()
    await screen.findByTestId('recovery-lab-entry')
    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('consumes the transient Runs-to-Home handoff once and prefers its downtime', async () => {
    recoveryLedger = { totalRecovered: 0, downtimeEndedMs: 0, sinceIso: null }
    mockAllClearApis()
    requestRecoveryAllClear({ downtimeMs: 3_660_000 })

    const { unmount } = render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)

    await waitFor(() => expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent(/^All clear$/))
    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent('1h 1m of downtime ended')
    unmount()

    render(<RecoveryCenterPanel {...baseProps} deadLetters={[]} />)
    await openHomeInsights()
    await screen.findByTestId('recovery-lab-entry')
    expect(screen.getByTestId('recovery-center-greeting')).not.toHaveTextContent(/^All clear$/)
  })
})

describe('<RecoveryCenterPanel /> — degraded metrics endpoint', () => {
  it('surfaces a soft warning when /recovery/metrics fails but still renders tiles', async () => {
    mockRecoveryApi(async (path: string) => {
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
    await openHomeInsights()

    await waitFor(() => {
      // Targeted match — the empty-budget tile also exposes role="status"
      // text now that the budget tile is in the grid, so we filter by the
      // unique "Metrics unavailable" copy instead of role-only.
      const statuses = screen.getAllByRole('status')
      const banner = statuses.find((node) => /Metrics unavailable/i.test(node.textContent ?? ''))
      expect(banner).toBeDefined()
      expect(banner).toHaveTextContent(/Metrics unavailable/i)
    })
    expect(screen.getByTestId('home-health-summary')).toHaveTextContent('Status is incomplete')
    expect(screen.getByTestId('recovery-center-action-triage_failures')).toBeInTheDocument()
  })
})
