/**
 * Recovery Center — the authenticated landing page (composer).
 *
 * Composes recovery signals from existing endpoints into a one-screen
 * summary: a hero strip with the org-wide health ring + greeting, a
 * five-cell metric strip (open failures / MTTR / approvals / replay / SLA),
 * the operator composer + content tiles (recovery queue / failure
 * clusters / pending approvals / recommended actions / budget / today),
 * the value dashboard, and a teaching empty-state hero for new operators.
 *
 * This file is the thin data-fetching wrapper. The presentational pieces
 * live in sibling files under `./recovery-center/`:
 * - `helpers.ts` — pure functions + data-shape types (no React).
 * - `HealthRing.tsx` — the SVG donut.
 * - `RecoveryCenterHero.tsx` — the greeting banner.
 * - `RecoveryCenterTiles.tsx` — the tile family (shared shell + 8 tiles).
 * - `RecoveryCenterComposer.tsx` — the AI ask box.
 * - `RecoveryCenterEmptyState.tsx` — the empty/new-org teaching hero.
 * The metric strip + value section reuse the already-extracted siblings
 * `VitalSignsStrip` + `ValueDashboardSection`.
 *
 * Data sources (all already shipped):
 * - `GET /recovery/metrics` → metric strip, health badge, severities.
 * - `GET /recovery/ledger` + `GET /recovery/my-wins` → verified lifetime and
 *   operator impact; polled cheaply so background-run completions surface.
 * - `GET /dlq/counts` + oldest-first `GET /dlq/queue` → authoritative hero
 *   count and longest open downtime; the bounded bootstrap page feeds tiles.
 * - `GET /dlq/clusters` → failure-clusters tile.
 * - Run nodes from the store (`status === "waiting"`) → pending approvals.
 *
 * The Recovery Center is composition over the recovery API + engine metrics.
 * Its heavier metrics, clusters, and heatmap reads start together on the
 * cross-panel `platformVersion` tick. Ledger, personal wins, and queue counts
 * use a separate bounded poll because the completing worker may belong to a
 * run that is not the operator's active SSE target.
 *
 * Used by `App.tsx` for `activeTab === 'home'`.
 *
 * Design language: see the `Recovery Center` block in
 * `apps/web/src/index.css`. Tokens-only, no inline hex. Animations
 * honour `prefers-reduced-motion`. Tab order: hero → metric strip →
 * tiles → recommended actions → empty-state CTAs.
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Target, Users, Zap } from 'lucide-react'
import type { ActiveTab, JsonObject, RunNode, RunSummary } from '../types'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'
import { tRecoveryMetricRationale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { ValueDashboardSection } from './ValueDashboardSection'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { OnboardingBanner } from './OnboardingBanner'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from './VitalSignsStrip'
import {
  buildGreeting,
  buildHeatmapCells,
  computeLongestOpenDowntime,
  computeRecommendedActions,
  computeStreaks,
  downtimeSeverity,
  formatDowntime,
  readDisplayName,
  readHealthScore,
  shouldShowOnboarding,
  type ClustersResponse,
  type HeatmapDay,
  type OperatorWins,
  type RecoveryLedger,
  type RecoveryMetrics,
} from './recovery-center/helpers'
import { RecoveryHeatmap } from './recovery-center/RecoveryHeatmap'
import { requestRecoveryDayFocus } from './recovery-day-focus-bus'
import {
  consumeRecoveryAllClear,
  parseRecoveryAllClearEvent,
  RECOVERY_ALL_CLEAR_EVENT,
  RECOVERY_ALL_CLEAR_WINDOW_MS,
  type RecoveryAllClearRequest,
} from './recovery-all-clear-bus'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { RecoveryCenterComposer } from './recovery-center/RecoveryCenterComposer'
import {
  BudgetTile,
  CalibrationHealthTile,
  FailureClustersTile,
  OperatorTodayTile,
  PendingApprovalsTile,
  RecommendedActionsTile,
  RecoveryQueueTile,
} from './recovery-center/RecoveryCenterTiles'
import { RecoveryFlowDemo } from './recovery-center/RecoveryCenterEmptyState'

type RecoveryCenterPanelProps = {
  runs: RunSummary[]
  runNodes: RunNode[]
  deadLetters: DeadLetter[]
  activeRunId: string | null
  onOpenTab: (tab: ActiveTab) => void
  onOpenRun: (runId: string) => void | Promise<void>
  onApproveNode: (nodeId: string) => void | Promise<void>
  onSubmitHumanForm: (nodeId: string, input: JsonObject) => void | Promise<void>
  /** Navigate to Runs and land keyboard focus on the Recovery Queue. */
  onOpenRecoveryQueue: () => void
  /** Inject a demo failure so a fresh operator can try the recovery loop for real. */
  onTryDemoRecovery?: () => void | Promise<void>
}

type OrgSnapshot<T> = {
  orgId: string
  value: T
}

type IdentitySnapshot<T> = OrgSnapshot<T> & {
  userId: string
}

type RecoveryQueueOverview = {
  orgId: string
  openCount: number
  oldestOpen: DeadLetter | null
  observedOpenIds: string[]
}

// Terminal recovery may complete in a worker for a run that is not the
// operator's active SSE/polling target. Keep this cheap projection live without
// repeatedly running the heavier metrics, cluster, and heatmap queries.
const RECOVERY_IMPACT_POLL_MS = 10_000

export function RecoveryCenterPanel(props: RecoveryCenterPanelProps) {
  const { t, i18n } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const activeOrgId = useWorkflowStore((state) => state.orgId)
  const resolvedOrgId = activeOrgId ?? 'default'
  const user = useWorkflowStore((state) => state.user)
  const authenticatedUserId = useWorkflowStore((state) => state.userId)
  const resolvedUserId = authenticatedUserId ?? user?.id ?? 'dev-user'
  const introDismissedThisSession = useWorkflowStore(
    (state) => state.recoveryIntroDismissedThisSession,
  )
  const dismissIntroThisSession = useWorkflowStore(
    (state) => state.dismissRecoveryIntroThisSession,
  )
  const [metricsSnapshot, setMetricsSnapshot] = useState<OrgSnapshot<RecoveryMetrics> | null>(null)
  const [clustersSnapshot, setClustersSnapshot] = useState<OrgSnapshot<ClustersResponse | null> | null>(null)
  const [heatmapSnapshot, setHeatmapSnapshot] = useState<OrgSnapshot<HeatmapDay[]> | null>(null)
  const [ledgerSnapshot, setLedgerSnapshot] = useState<OrgSnapshot<RecoveryLedger | null> | null>(null)
  const [winsSnapshot, setWinsSnapshot] = useState<IdentitySnapshot<OperatorWins | null> | null>(null)
  const [impactPollVersion, setImpactPollVersion] = useState(0)
  const metrics = metricsSnapshot?.orgId === resolvedOrgId ? metricsSnapshot.value : null
  const clusters = clustersSnapshot?.orgId === resolvedOrgId ? clustersSnapshot.value : null
  const heatmap = heatmapSnapshot?.orgId === resolvedOrgId ? heatmapSnapshot.value : []
  const ledger = ledgerSnapshot?.orgId === resolvedOrgId ? ledgerSnapshot.value : null
  const operatorWins = winsSnapshot?.orgId === resolvedOrgId && winsSnapshot.userId === resolvedUserId
    ? winsSnapshot.value
    : null
  const [queueOverview, setQueueOverview] = useState<RecoveryQueueOverview | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [metricsErrorSnapshot, setMetricsErrorSnapshot] = useState<OrgSnapshot<string> | null>(null)
  const metricsError = metricsErrorSnapshot?.orgId === resolvedOrgId
    ? metricsErrorSnapshot.value
    : null
  const [currentHour, setCurrentHour] = useState(12)
  const [nowMs, setNowMs] = useState<number | null>(null)
  const [allClear, setAllClear] = useState(false)
  const [allClearDowntimeOverride, setAllClearDowntimeOverride] = useState<number | null>(null)
  const [celebrationTrigger, setCelebrationTrigger] = useState(0)
  const previousRecoveryLedgerRef = useRef<OrgSnapshot<RecoveryLedger> | null>(null)
  const pendingVerifiedRecoveryRef = useRef<{
    orgId: string
    totalRecovered: number
    downtimeMs: number
  } | null>(null)
  const [persistedIntroDismissed, setPersistedIntroDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem('janusly:recovery:hideIntro') === 'true' } catch { return false }
  })
  const dismissIntro = () => {
    dismissIntroThisSession()
    if ((metrics?.terminalRuns ?? 0) <= 0) return
    setPersistedIntroDismissed(true)
    try { localStorage.setItem('janusly:recovery:hideIntro', 'true') } catch { /* storage unavailable — session-only dismiss */ }
  }

  useEffect(() => {
    let cancelled = false
    setMetricsLoading(true)
    setMetricsErrorSnapshot(null)

    // Invoke all three heavier reads before attaching handlers so one render commits
    // one coordinated request burst without making any result wait for a
    // slower sibling endpoint.
    const metricsRequest = api('/recovery/metrics')
    const clustersRequest = api('/dlq/clusters')
    const heatmapRequest = api('/recovery/heatmap?days=90')

    void metricsRequest
      .then((payload) => {
        if (cancelled) return
        setMetricsSnapshot({ orgId: resolvedOrgId, value: payload as RecoveryMetrics })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setMetricsErrorSnapshot({
          orgId: resolvedOrgId,
          value: error instanceof Error
            ? error.message
            : runtimeT('recoveryCenter.empty.metricsUnavailableFallback'),
        })
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false)
      })

    void clustersRequest
      .then((payload) => {
        if (cancelled) return
        startTransition(() => {
          setClustersSnapshot({
            orgId: resolvedOrgId,
            value: payload as ClustersResponse,
          })
        })
      })
      .catch(() => {
        if (cancelled) return
        startTransition(() => {
          setClustersSnapshot({ orgId: resolvedOrgId, value: null })
        })
      })

    void heatmapRequest
      .then((payload) => {
        if (cancelled) return
        startTransition(() => {
          setHeatmapSnapshot({
            orgId: resolvedOrgId,
            value: ((payload as { days?: HeatmapDay[] })?.days ?? []),
          })
        })
      })
      .catch(() => {
        if (cancelled) return
        startTransition(() => {
          setHeatmapSnapshot({ orgId: resolvedOrgId, value: [] })
        })
      })

    return () => { cancelled = true }
  }, [platformVersion, resolvedOrgId])

  useEffect(() => {
    const id = window.setInterval(() => {
      setImpactPollVersion((version) => version + 1)
    }, RECOVERY_IMPACT_POLL_MS)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    const ledgerRequest = api('/recovery/ledger')
    const winsRequest = api('/recovery/my-wins?days=30')

    void ledgerRequest
      .then((payload) => {
        if (cancelled) return
        startTransition(() => {
          setLedgerSnapshot({ orgId: resolvedOrgId, value: payload as RecoveryLedger })
        })
      })
      .catch(() => {
        if (cancelled) return
        startTransition(() => {
          setLedgerSnapshot({ orgId: resolvedOrgId, value: null })
        })
      })

    void winsRequest
      .then((payload) => {
        if (cancelled) return
        startTransition(() => {
          setWinsSnapshot({
            orgId: resolvedOrgId,
            userId: resolvedUserId,
            value: payload as OperatorWins,
          })
        })
      })
      .catch(() => {
        if (cancelled) return
        startTransition(() => {
          setWinsSnapshot({ orgId: resolvedOrgId, userId: resolvedUserId, value: null })
        })
      })

    return () => { cancelled = true }
  }, [impactPollVersion, platformVersion, resolvedOrgId, resolvedUserId])

  useEffect(() => {
    let cancelled = false
    const observedOpenIds = props.deadLetters
      .filter((deadLetter) => deadLetter.status === 'open')
      .map((deadLetter) => deadLetter.id)
    void api('/dlq/counts')
      .then(async (payload) => {
        if (cancelled) return
        const open = (payload as { open?: unknown } | null)?.open
        if (typeof open !== 'number' || !Number.isInteger(open) || open < 0) return

        if (open === 0) {
          setQueueOverview({ orgId: resolvedOrgId, openCount: 0, oldestOpen: null, observedOpenIds })
          return
        }

        const queuePayload = await api('/dlq/queue?status=open&sort=oldest&limit=1').catch(() => null)
        if (cancelled) return
        const items = (queuePayload as { items?: unknown } | null)?.items
        setQueueOverview({
          orgId: resolvedOrgId,
          openCount: open,
          oldestOpen: Array.isArray(items) && items.length > 0 ? items[0] as DeadLetter : null,
          observedOpenIds,
        })
      })
      .catch(() => {
        // Keep the bounded bootstrap-page fallback when the summary is unavailable.
      })
    return () => { cancelled = true }
  }, [impactPollVersion, platformVersion, props.deadLetters, resolvedOrgId])

  const openDeadLetters = useMemo(
    () => props.deadLetters.filter((dlq) => dlq.status === 'open'),
    [props.deadLetters],
  )
  const currentQueueOverview = queueOverview?.orgId === resolvedOrgId ? queueOverview : null
  // A fresh bootstrap page can learn about a newly-opened failure after the
  // count request starts, so rows absent from that request's input snapshot
  // remain a fail-safe lower bound. Rows the request already observed can be
  // retired by a later authoritative zero; otherwise a worker-owned terminal
  // recovery would leave a stale bootstrap row blocking all-clear forever.
  const unobservedVisibleFailures = currentQueueOverview
    ? openDeadLetters.filter((deadLetter) => !currentQueueOverview.observedOpenIds.includes(deadLetter.id)).length
    : openDeadLetters.length
  const openFailureCount = Math.max(currentQueueOverview?.openCount ?? 0, unobservedVisibleFailures)

  const celebrateAllClear = useCallback((request?: RecoveryAllClearRequest | null) => {
    setAllClearDowntimeOverride(request?.downtimeMs ?? null)
    setAllClear(true)
    setCelebrationTrigger((trigger) => trigger + 1)
  }, [])

  useEffect(() => {
    if (!ledger) return
    const previous = previousRecoveryLedgerRef.current
    previousRecoveryLedgerRef.current = { orgId: resolvedOrgId, value: ledger }
    if (previous?.orgId !== resolvedOrgId) {
      pendingVerifiedRecoveryRef.current = null
      return
    }
    if (ledger.totalRecovered > previous.value.totalRecovered) {
      const current = pendingVerifiedRecoveryRef.current
      pendingVerifiedRecoveryRef.current = {
        orgId: resolvedOrgId,
        totalRecovered: ledger.totalRecovered,
        downtimeMs:
          (current?.orgId === resolvedOrgId ? current.downtimeMs : 0)
          + Math.max(0, ledger.downtimeEndedMs - previous.value.downtimeEndedMs),
      }
    }
  }, [ledger, resolvedOrgId])

  useEffect(() => {
    const pending = pendingVerifiedRecoveryRef.current
    if (!pending || pending.orgId !== resolvedOrgId || openFailureCount !== 0) return
    pendingVerifiedRecoveryRef.current = null
    celebrateAllClear({ downtimeMs: pending.downtimeMs })
  }, [celebrateAllClear, ledger, openFailureCount, resolvedOrgId])

  useEffect(() => {
    if (openFailureCount > 0) {
      setAllClear(false)
      setAllClearDowntimeOverride(null)
    }
  }, [openFailureCount])

  useEffect(() => {
    if (openFailureCount !== 0) return

    const pending = consumeRecoveryAllClear(resolvedOrgId)
    if (pending) {
      pendingVerifiedRecoveryRef.current = null
      celebrateAllClear(pending)
    }

    const onAllClear = (event: Event) => {
      const request = parseRecoveryAllClearEvent(event, resolvedOrgId)
      if (!request) return
      consumeRecoveryAllClear(resolvedOrgId)
      pendingVerifiedRecoveryRef.current = null
      celebrateAllClear(request)
    }
    window.addEventListener(RECOVERY_ALL_CLEAR_EVENT, onAllClear)
    return () => window.removeEventListener(RECOVERY_ALL_CLEAR_EVENT, onAllClear)
  }, [celebrateAllClear, openFailureCount, resolvedOrgId])

  useEffect(() => {
    if (!allClear) return
    const id = window.setTimeout(() => {
      setAllClear(false)
      setAllClearDowntimeOverride(null)
    }, RECOVERY_ALL_CLEAR_WINDOW_MS)
    return () => window.clearTimeout(id)
  }, [allClear, celebrationTrigger])

  useEffect(() => {
    setCurrentHour(new Date().getHours())
  }, [])

  // Live "downtime clock": re-anchor the reference time on mount and whenever
  // the data changes, then tick once a minute so open-failure ages advance in
  // place — ONE interval for the whole panel, never a timer per row.
  useEffect(() => {
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [platformVersion, openFailureCount])

  const waitingNodes = useMemo(
    () => props.runNodes.filter((node) => node.status === 'waiting'),
    [props.runNodes],
  )
  const topClusters = useMemo(
    () => (clusters?.clusters ?? []).slice().sort((a, b) => b.frequency - a.frequency).slice(0, 3),
    [clusters],
  )
  const topClusterFrequency = topClusters[0]?.frequency ?? 0
  const heatmapCells = useMemo(
    () => nowMs === null ? [] : buildHeatmapCells(heatmap, 90, nowMs),
    [heatmap, nowMs],
  )
  const hasRecoveryHistory = heatmapCells.some((cell) => cell.failures > 0 || cell.recovered > 0)
  const streak = useMemo(
    () => hasRecoveryHistory ? computeStreaks(heatmapCells) : { current: 0, longest: 0 },
    [hasRecoveryHistory, heatmapCells],
  )
  const longestOpen = useMemo(
    () => computeLongestOpenDowntime(
      currentQueueOverview?.oldestOpen
        ? [currentQueueOverview.oldestOpen]
        : currentQueueOverview?.openCount
          ? []
          : openDeadLetters,
      nowMs,
    ),
    [currentQueueOverview, nowMs, openDeadLetters],
  )

  const totalRuns = props.runs.length
  const healthScore = readHealthScore(metrics)
  // `buildGreeting` and `computeRecommendedActions` call `runtimeT(...)`
  // internally, so the memo MUST re-compute when the active locale changes;
  // adding `i18n.language` to the dep array is the cheapest fix that keeps
  // the helper functions pure (vs. plumbing `t` through every call site).
  const greeting = useMemo(() => buildGreeting({
    hour: currentHour,
    displayName: readDisplayName(user),
    openFailures: openFailureCount,
    pendingApprovals: waitingNodes.length,
    healthScore,
    totalRuns,
  }), [currentHour, user, openFailureCount, waitingNodes.length, healthScore, totalRuns, i18n.language])

  const recommendedActions = useMemo(() => computeRecommendedActions({
    openFailures: openFailureCount,
    pendingApprovals: waitingNodes.length,
    topClusterFrequency,
    healthScore,
    totalRuns,
  }), [openFailureCount, waitingNodes.length, topClusterFrequency, healthScore, totalRuns, i18n.language])

  const isEmpty = openFailureCount === 0
    && waitingNodes.length === 0
    && (clusters?.clusters.length ?? 0) === 0
  // Before the first terminal run, dismissal lasts only for this authenticated
  // store session so a reload restores the demo. Real history upgrades the
  // same choice to the durable preference operators already had.
  const introDismissed = (metrics?.terminalRuns ?? 0) > 0
    ? persistedIntroDismissed
    : introDismissedThisSession
  const showOnboarding = metrics !== null
    && shouldShowOnboarding({
      runs: props.runs.length,
      openFailures: openFailureCount,
      waitingApprovals: waitingNodes.length,
      dismissed: introDismissed,
    })
    && totalRuns === 0

  const failuresLabel = t('recoveryCenter.metric.failures.label') as string
  const failuresDisplay = openFailureCount === 0 ? '0' : String(openFailureCount)
  const failuresRationale = openFailureCount === 0
    ? t('recoveryCenter.metric.failures.rationaleEmpty') as string
    : t('recoveryCenter.metric.failures.rationale') as string
  const homeTiles: VitalSignsTile[] = [
    {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      label: failuresLabel,
      display: failuresDisplay,
      numericValue: openFailureCount,
      severity: openFailureCount === 0 ? 'healthy' : openFailureCount > 5 ? 'unhealthy' : 'warn',
      rationale: failuresRationale,
      ariaLabel: t('recoveryCenter.metric.aria', { label: failuresLabel, display: failuresDisplay, rationale: failuresRationale }) as string,
      onClick: props.onOpenRecoveryQueue,
      testId: 'recovery-center-metric-failures',
    },
  ]
  // Append the three computed tiles. Each pushes a fully-formed VitalSignsTile;
  // the inline composition keeps the rich aria-label (label + display + rationale)
  // the legacy RecoveryCenterMetric provided to screen readers.
  const mttrLabel = t('recoveryCenter.metric.mttr.label') as string
  const mttrDisplay = metrics?.mttr.display ?? '—'
  const mttrRationale = metrics?.mttr
    ? tRecoveryMetricRationale(metrics.mttr)
    : t('recoveryCenter.metric.mttr.rationaleFallback') as string
  // MTTR trend sparkline: needs ≥2 daily points to tell a story. The hover
  // title lists the exact per-day values the sparkline plots.
  const mttrTrend = metrics?.mttrTrend ?? []
  const mttrTrendSeconds = mttrTrend.map((point) => point.seconds)
  const mttrTrendPointLabels = mttrTrend.map(
    (point) => `${point.day}: ${formatDowntime(point.seconds * 1000)}`,
  )
  const mttrTrendTitle = mttrTrendPointLabels.join('\n')
  homeTiles.push({
    icon: <RefreshCw size={14} aria-hidden="true" />,
    label: mttrLabel,
    display: mttrDisplay,
    numericValue: metrics?.mttr.value ?? null,
    severity: metrics?.mttr.severity ?? 'neutral',
    rationale: mttrRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: mttrLabel, display: mttrDisplay, rationale: mttrRationale }) as string,
    sparkline: mttrTrendSeconds.length >= 2 ? mttrTrendSeconds : undefined,
    sparklineLabel: t('recoveryCenter.metric.mttr.trendAria', { count: mttrTrendSeconds.length }) as string,
    sparklineTitle: mttrTrendSeconds.length >= 2 ? mttrTrendTitle : undefined,
    sparklinePointLabels: mttrTrendSeconds.length >= 2 ? mttrTrendPointLabels : undefined,
    onSelectSparklinePoint: mttrTrendSeconds.length >= 2
      ? (index) => {
          const day = mttrTrend[index]?.day
          if (!day) return
          requestRecoveryDayFocus(day)
          props.onOpenTab('runs')
        }
      : undefined,
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-mttr',
  })
  const approvalsLabel = t('recoveryCenter.metric.approvals.label') as string
  const approvalsDisplay = waitingNodes.length === 0 ? '0' : String(waitingNodes.length)
  const approvalsRationale = waitingNodes.length === 0
    ? t('recoveryCenter.metric.approvals.rationaleEmpty') as string
    : t('recoveryCenter.metric.approvals.rationale') as string
  homeTiles.push({
    icon: <Users size={14} aria-hidden="true" />,
    label: approvalsLabel,
    display: approvalsDisplay,
    numericValue: waitingNodes.length,
    severity: waitingNodes.length === 0 ? 'healthy' : 'warn',
    rationale: approvalsRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: approvalsLabel, display: approvalsDisplay, rationale: approvalsRationale }) as string,
    onClick: () => props.onOpenTab('runs'),
    testId: 'recovery-center-metric-approvals',
  })
  const replayLabel = t('recoveryCenter.metric.replay.label') as string
  const replayDisplay = metrics?.replayRate.display ?? '—'
  const replayRationale = metrics?.replayRate
    ? tRecoveryMetricRationale(metrics.replayRate)
    : t('recoveryCenter.metric.replay.rationaleFallback') as string
  homeTiles.push({
    icon: <Zap size={14} aria-hidden="true" />,
    label: replayLabel,
    display: replayDisplay,
    numericValue: metrics?.replayRate.value ?? null,
    severity: metrics?.replayRate.severity ?? 'neutral',
    rationale: replayRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: replayLabel, display: replayDisplay, rationale: replayRationale }) as string,
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-replay',
  })
  const slaLabel = t('recoveryCenter.metric.sla.label') as string
  const slaDisplay = metrics?.slaAttainment?.display ?? '—'
  const slaRationale = metrics?.slaAttainment
    ? tRecoveryMetricRationale(metrics.slaAttainment)
    : t('recoveryCenter.metric.sla.rationaleFallback') as string
  homeTiles.push({
    icon: <Target size={14} aria-hidden="true" />,
    label: slaLabel,
    display: slaDisplay,
    numericValue: metrics?.slaAttainment?.value ?? null,
    severity: metrics?.slaAttainment?.severity ?? 'neutral',
    rationale: slaRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: slaLabel, display: slaDisplay, rationale: slaRationale }) as string,
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-sla',
  })
  const metricStrip = (
    <VitalSignsStrip
      tiles={withSeverityLabels(homeTiles, t)}
      ariaLabel={t('recoveryCenter.metricStripAria') as string}
      testId="recovery-center-metric-strip"
    />
  )

  // Operator chat surface (left, 1.7fr) + live status rail (right, 1fr).
  // Mirrors `ui_kits/studio/home-operator.html` from the design system zip.
  // The layout is the same in empty and populated states — every tile
  // surfaces its own AllClearState when it has nothing to show, so the
  // operator's mental model never changes between "fresh install" and
  // "production workflow".
  return (
    <div className="we-recovery-center-panel we-recovery-center-panel--operator">
      <RecoveryCenterHero
        salutation={greeting.salutation}
        subline={greeting.subline}
        healthScore={healthScore}
        openFailures={openFailureCount}
        streak={streak}
        longestOpenMs={longestOpen?.durationMs}
        longestOpenSeverity={downtimeSeverity(longestOpen?.createdAt, nowMs)}
        allClear={allClear && openFailureCount === 0}
        allClearDowntimeMs={allClearDowntimeOverride ?? metrics?.downtimeEndedMs}
        celebrationTrigger={celebrationTrigger}
        personalWins={operatorWins}
        onOpenQueue={props.onOpenRecoveryQueue}
      />

      <OnboardingBanner onOpenTab={props.onOpenTab} />

      {metricStrip}

      <RecoveryHeatmap
        days={heatmap}
        cells={heatmapCells}
        windowDays={90}
        nowMs={nowMs}
        onSelectDay={(day) => {
          requestRecoveryDayFocus(day)
          props.onOpenTab('runs')
        }}
      />

      <div className="we-operator-grid">
        <section className="we-operator-chat">
          <RecoveryCenterComposer
            onOpenTab={props.onOpenTab}
            recentDlqRunId={openDeadLetters[0]?.runId}
            showSeedTranscript={isEmpty}
          />
          {showOnboarding && (
            <RecoveryFlowDemo
              onOpenStudio={() => props.onOpenTab('copilot')}
              onOpenRecipes={() => props.onOpenTab('templates')}
              onTryDemo={props.onTryDemoRecovery}
              onDismiss={dismissIntro}
            />
          )}
          <RecommendedActionsTile actions={recommendedActions} onOpenTab={props.onOpenTab} />
          <RecoveryQueueTile
            deadLetters={openDeadLetters}
            runs={props.runs}
            nowMs={nowMs}
            onOpenRun={props.onOpenRun}
            onOpenQueue={props.onOpenRecoveryQueue}
          />
        </section>
        <aside className="we-operator-rail" aria-label={t('recoveryCenter.railAria')}>
          <PendingApprovalsTile
            waitingNodes={waitingNodes}
            runs={props.runs}
            onOpenRun={props.onOpenRun}
            onOpenTab={props.onOpenTab}
            onApproveNode={props.onApproveNode}
          />
          <FailureClustersTile
            clusters={topClusters}
            totalSamples={clusters?.totalSamples ?? 0}
            onOpenTab={props.onOpenTab}
          />
          <CalibrationHealthTile />
          <OperatorTodayTile
            metrics={metrics}
            openDeadLetters={openFailureCount}
            waitingNodes={waitingNodes.length}
            onOpenTab={props.onOpenTab}
          />
          <BudgetTile onOpenTab={props.onOpenTab} />
        </aside>
      </div>

      <ValueDashboardSection
        mttrMs={metrics?.mttr.value ?? null}
        mttrDisplay={metrics?.mttr.display ?? '—'}
        clustersResolved={metrics?.clustersResolved}
        valueEstimate={metrics?.valueEstimate}
        windowDays={metrics?.windowDays ?? 30}
        downtimeEndedMs={metrics?.downtimeEndedMs}
        ledger={ledger}
        terminalRunsZero={(metrics?.terminalRuns ?? 0) === 0}
      />

      {metricsError && !metricsLoading && (
        <p className="we-recovery-center-error" role="status">
          {t('recoveryCenter.metricsUnavailable', { detail: metricsError })}
        </p>
      )}

      <OnboardingReplayButton />
    </div>
  )
}
