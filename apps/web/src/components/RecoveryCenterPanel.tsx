/**
 * Recovery Center — the authenticated landing page (composer).
 *
 * Composes recovery signals from existing endpoints into a one-screen
 * summary: a hero strip with the org-wide health ring + greeting, a
 * seven-cell metric strip (open failures / verified recovery / first action / approvals /
 * replay / fix durability / SLA),
 * the operator composer + content tiles (recovery queue / failure
 * clusters / pending approvals / recommended actions / budget / today),
 * controlled-drill validation, the value dashboard, and a teaching empty-state
 * hero for new operators.
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
 * Data sources:
 * - `GET /recovery/home` → one coalesced snapshot for recovery metrics,
 *   validation, clusters, semantic cases, lifetime/operator impact, heatmap,
 *   and the authoritative queue overview.
 * - `GET /recovery/home?scope=impact` → a lightweight convergence snapshot for
 *   the ledger, personal wins, and queue while background work completes.
 * - Run nodes from the store (`status === "waiting"`) → pending approvals.
 *
 * The Recovery Center is composition over the recovery API + engine metrics.
 * Each server section settles independently, so one unavailable projection
 * never hides healthy data. The full snapshot refreshes on the cross-panel
 * `platformVersion` tick. The impact scope uses a visibility-aware fallback
 * because the completing worker may belong to a run that is not the operator's
 * active SSE target. Open recovery work keeps a short convergence window; a
 * healthy Home uses a slower fallback.
 *
 * Used by `App.tsx` for `activeTab === 'home'`.
 *
 * Design language: see the `Recovery Center` block in
 * `apps/web/src/styles/platform.css`. Tokens-only, no inline hex. Animations
 * honour `prefers-reduced-motion`. Tab order: hero → metric strip →
 * tiles → recommended actions → empty-state CTAs.
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Hourglass, RefreshCw, ShieldCheck, Target, Users, Zap } from 'lucide-react'
import type {
  ActiveTab,
  RecoveryCase,
  RunNode,
  RunSummary,
} from '../types'
import { api } from '../api'
import { useMemoryConsentStatus } from '../hooks/useMemoryConsentStatus'
import { getMemoryPurgeCountdown } from '../memory-consent-status'
import {
  parseRecoveryHomeSnapshot,
  readRecoveryHomeSection,
  type RecoveryHomeSnapshot,
} from '../recovery-home-snapshot'
import {
  decodeClustersResponse,
  decodeHeatmap,
  decodeOperatorWins,
  decodeRecoveryCases,
  decodeRecoveryLedger,
  decodeRecoveryMetrics,
  decodeRecoveryQueue,
  decodeRecoveryValidationReport,
} from '../recovery-home-sections'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'
import { tRecoveryMetricRationale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { ValueDashboardSection } from './ValueDashboardSection'
import {
  RecoveryValidationSection,
  type RecoveryValidationReport,
} from './RecoveryValidationSection'
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
} from './recovery-center/recovery-center-model'
import { RecoveryHeatmap } from './recovery-center/RecoveryHeatmap'
import { requestRecoveryDayFocus } from './recovery-day-focus-bus'
import { selectRecoveryTimeMetric } from './recovery-metrics'
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
  SemanticRecoveryCasesTile,
} from './recovery-center/RecoveryCenterTiles'
import { RecoveryLabEntry } from './recovery-center/RecoveryCenterEmptyState'

type RecoveryCenterPanelProps = {
  runs: RunSummary[]
  runNodes: RunNode[]
  deadLetters: DeadLetter[]
  /** Keep the global recovery posture synchronized with durable semantic containment. */
  onSemanticBlockerRunsChange?: (runIds: string[]) => void
  onOpenTab: (tab: ActiveTab) => void
  onOpenRecoveryCase: (caseId: string) => void
  onOpenRun: (runId: string, targetTab?: ActiveTab) => void | Promise<void>
  onApproveNode: (nodeId: string) => void | Promise<void>
  /** Navigate to Recover and land keyboard focus on the Recovery Queue. */
  onOpenRecoveryQueue: () => void
  /** Start a deterministic drill so a fresh operator can try the recovery loop for real. */
  onStartRecoveryDrill?: () => void | Promise<void>
  /** Refresh shell-level projections after a Recovery Center mutation. */
  onRefreshPlatform?: () => void | Promise<void>
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
  oldestOpen: { createdAt?: string } | null
  observedOpenIds: string[]
}

type SemanticCasesStatus = 'loading' | 'available' | 'unavailable'

// Terminal recovery may complete in a worker for a run that is not the
// operator's active SSE/polling target. Keep this cheap projection live without
// repeatedly running the heavier metrics, cluster, and heatmap queries.
const RECOVERY_IMPACT_ACTIVE_POLL_MS = 10_000
const RECOVERY_IMPACT_IDLE_POLL_MS = 60_000

export function RecoveryCenterPanel(props: RecoveryCenterPanelProps) {
  const { t, i18n } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const { status: memoryConsentStatus } = useMemoryConsentStatus()
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
  const [validationSnapshot, setValidationSnapshot] = useState<OrgSnapshot<RecoveryValidationReport | null> | null>(null)
  const [semanticCasesSnapshot, setSemanticCasesSnapshot] = useState<OrgSnapshot<{
    cases: RecoveryCase[]
    status: SemanticCasesStatus
  }> | null>(null)
  const [ledgerSnapshot, setLedgerSnapshot] = useState<OrgSnapshot<RecoveryLedger | null> | null>(null)
  const [winsSnapshot, setWinsSnapshot] = useState<IdentitySnapshot<OperatorWins | null> | null>(null)
  const [impactPollVersion, setImpactPollVersion] = useState(0)
  const metrics = metricsSnapshot?.orgId === resolvedOrgId ? metricsSnapshot.value : null
  const clusters = clustersSnapshot?.orgId === resolvedOrgId ? clustersSnapshot.value : null
  const heatmap = heatmapSnapshot?.orgId === resolvedOrgId ? heatmapSnapshot.value : []
  const validation = validationSnapshot?.orgId === resolvedOrgId ? validationSnapshot.value : undefined
  const semanticCases = semanticCasesSnapshot?.orgId === resolvedOrgId
    ? semanticCasesSnapshot.value.cases
    : []
  const semanticCasesStatus = semanticCasesSnapshot?.orgId === resolvedOrgId
    ? semanticCasesSnapshot.value.status
    : 'loading'
  const semanticCasesUnavailable = semanticCasesStatus === 'unavailable'
  const semanticCasesLoading = semanticCasesStatus === 'loading'
  const semanticOutcomePosture = semanticCases.length > 0
    ? 'attention'
    : semanticCasesStatus === 'available'
      ? 'clear'
      : semanticCasesStatus
  const semanticBlockerRunIds = useMemo(
    () => [...new Set(
      semanticCases
        .filter((item) => item.action === 'quarantine' && item.state === 'contained')
        .map((item) => item.runId),
    )],
    [semanticCases],
  )
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
  const identityRef = useRef({ orgId: resolvedOrgId, userId: resolvedUserId })
  identityRef.current = { orgId: resolvedOrgId, userId: resolvedUserId }
  const observedOpenIdsRef = useRef<string[]>([])
  observedOpenIdsRef.current = props.deadLetters
    .filter((deadLetter) => deadLetter.status === 'open')
    .map((deadLetter) => deadLetter.id)
  useEffect(() => {
    props.onSemanticBlockerRunsChange?.(semanticBlockerRunIds)
  }, [props.onSemanticBlockerRunsChange, semanticBlockerRunIds])

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

  const applyImpactSnapshot = useCallback((
    snapshot: RecoveryHomeSnapshot,
    orgId: string,
    userId: string,
  ) => {
    const ledgerValue = readRecoveryHomeSection(
      snapshot,
      'ledger',
      decodeRecoveryLedger,
    )
    const winsValue = readRecoveryHomeSection(
      snapshot,
      'wins',
      decodeOperatorWins,
    )
    const queueValue = readRecoveryHomeSection(
      snapshot,
      'queue',
      decodeRecoveryQueue,
    )
    startTransition(() => {
      setLedgerSnapshot({
        orgId,
        value: ledgerValue,
      })
      setWinsSnapshot({
        orgId,
        userId,
        value: winsValue,
      })
      if (queueValue) {
        const open = queueValue.counts.open
        setQueueOverview({
          orgId,
          openCount: open,
          oldestOpen: queueValue.oldestOpen,
          observedOpenIds: [...observedOpenIdsRef.current],
        })
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    setMetricsLoading(true)
    setMetricsErrorSnapshot(null)
    setSemanticCasesSnapshot(current => ({
      orgId: resolvedOrgId,
      value: {
        cases: current?.orgId === resolvedOrgId ? current.value.cases : [],
        status: 'loading',
      },
    }))

    void api('/recovery/home')
      .then((payload) => {
        if (cancelled) return
        const snapshot = parseRecoveryHomeSnapshot(payload)
        if (!snapshot || snapshot.scope !== 'full') {
          throw new Error('Invalid recovery Home response')
        }

        const metricsValue = readRecoveryHomeSection(
          snapshot,
          'metrics',
          decodeRecoveryMetrics,
        )
        const clustersValue = readRecoveryHomeSection(
          snapshot,
          'clusters',
          decodeClustersResponse,
        )
        const heatmapValue = readRecoveryHomeSection(
          snapshot,
          'heatmap',
          decodeHeatmap,
        )
        const validationValue = readRecoveryHomeSection(
          snapshot,
          'validation',
          decodeRecoveryValidationReport,
        )
        const casesValue = readRecoveryHomeSection(
          snapshot,
          'cases',
          decodeRecoveryCases,
        )

        if (metricsValue) {
          setMetricsSnapshot({ orgId: resolvedOrgId, value: metricsValue })
        } else {
          setMetricsErrorSnapshot({
            orgId: resolvedOrgId,
            value: runtimeT('recoveryCenter.empty.metricsUnavailableFallback'),
          })
        }

        startTransition(() => {
          setClustersSnapshot({
            orgId: resolvedOrgId,
            value: clustersValue,
          })
          setHeatmapSnapshot({
            orgId: resolvedOrgId,
            value: heatmapValue?.days ?? [],
          })
          setValidationSnapshot({
            orgId: resolvedOrgId,
            value: validationValue,
          })
        })

        if (casesValue) {
          setSemanticCasesSnapshot({
            orgId: resolvedOrgId,
            value: { cases: casesValue.cases, status: 'available' },
          })
        } else {
          setSemanticCasesSnapshot(current => ({
            orgId: resolvedOrgId,
            value: {
              cases: current?.orgId === resolvedOrgId ? current.value.cases : [],
              status: 'unavailable',
            },
          }))
        }
        applyImpactSnapshot(snapshot, resolvedOrgId, resolvedUserId)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setMetricsErrorSnapshot({
          orgId: resolvedOrgId,
          value: error instanceof Error
            ? error.message
            : runtimeT('recoveryCenter.empty.metricsUnavailableFallback'),
        })
        startTransition(() => {
          setClustersSnapshot({ orgId: resolvedOrgId, value: null })
          setHeatmapSnapshot({ orgId: resolvedOrgId, value: [] })
          setValidationSnapshot({ orgId: resolvedOrgId, value: null })
          setLedgerSnapshot({ orgId: resolvedOrgId, value: null })
          setWinsSnapshot({ orgId: resolvedOrgId, userId: resolvedUserId, value: null })
        })
        setSemanticCasesSnapshot(current => ({
          orgId: resolvedOrgId,
          value: {
            cases: current?.orgId === resolvedOrgId ? current.value.cases : [],
            status: 'unavailable',
          },
        }))
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false)
      })

    return () => { cancelled = true }
  }, [applyImpactSnapshot, platformVersion, resolvedOrgId, resolvedUserId])

  useEffect(() => {
    if (impactPollVersion === 0) return
    let cancelled = false
    const { orgId, userId } = identityRef.current
    void api('/recovery/home?scope=impact')
      .then((payload) => {
        if (cancelled) return
        const snapshot = parseRecoveryHomeSnapshot(payload)
        if (!snapshot || snapshot.scope !== 'impact') return
        applyImpactSnapshot(snapshot, orgId, userId)
      })
      .catch(() => {
        // Keep the last healthy impact projection when a convergence poll fails.
      })
    return () => { cancelled = true }
  }, [applyImpactSnapshot, impactPollVersion])

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
  const recoveryClearEligible = openFailureCount === 0 && semanticOutcomePosture === 'clear'

  // Local mutations and active-run terminal events already bump
  // `platformVersion`, so polling is only a convergence fallback for work
  // completed by another worker/run. Stay responsive while failures are open,
  // reduce healthy-home reads sixfold, and stop all background-tab polling.
  const impactPollMs = openFailureCount > 0
    ? RECOVERY_IMPACT_ACTIVE_POLL_MS
    : RECOVERY_IMPACT_IDLE_POLL_MS
  useEffect(() => {
    let timeoutId: number | null = null

    const clearScheduledPoll = () => {
      if (timeoutId === null) return
      window.clearTimeout(timeoutId)
      timeoutId = null
    }
    const schedulePoll = () => {
      clearScheduledPoll()
      if (document.hidden) return
      timeoutId = window.setTimeout(() => {
        timeoutId = null
        setImpactPollVersion((version) => version + 1)
        schedulePoll()
      }, impactPollMs)
    }
    const handleVisibilityChange = () => {
      clearScheduledPoll()
      if (document.hidden) return
      setImpactPollVersion((version) => version + 1)
      schedulePoll()
    }

    schedulePoll()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      clearScheduledPoll()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [impactPollMs])

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
    if (!pending || pending.orgId !== resolvedOrgId || !recoveryClearEligible) return
    pendingVerifiedRecoveryRef.current = null
    celebrateAllClear({ downtimeMs: pending.downtimeMs })
  }, [celebrateAllClear, ledger, recoveryClearEligible, resolvedOrgId])

  useEffect(() => {
    if (!recoveryClearEligible) {
      setAllClear(false)
      setAllClearDowntimeOverride(null)
    }
  }, [recoveryClearEligible])

  useEffect(() => {
    if (!recoveryClearEligible) return

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
  }, [celebrateAllClear, recoveryClearEligible, resolvedOrgId])

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
  const memoryPurgeCountdown = useMemo(() => {
    if (
      nowMs === null ||
      memoryConsentStatus?.tenantEnabled !== false ||
      memoryConsentStatus.purge.status !== 'scheduled'
    ) return null
    return getMemoryPurgeCountdown(memoryConsentStatus.purge.scheduledFor, nowMs)
  }, [memoryConsentStatus, nowMs])
  const memoryPurgeCountdownLabel = memoryPurgeCountdown
    ? memoryPurgeCountdown.days > 0
      ? t('recoveryCenter.hero.memoryPurgeDays', memoryPurgeCountdown)
      : memoryPurgeCountdown.hours > 0
        ? t('recoveryCenter.hero.memoryPurgeHours', memoryPurgeCountdown)
        : memoryPurgeCountdown.minutes > 0
          ? t('recoveryCenter.hero.memoryPurgeMinutes', memoryPurgeCountdown)
          : t('recoveryCenter.hero.memoryPurgeDue')
    : null

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
    semanticOutcomePosture,
    semanticCaseCount: semanticCases.length,
  }), [
    currentHour,
    user,
    openFailureCount,
    waitingNodes.length,
    healthScore,
    totalRuns,
    semanticOutcomePosture,
    semanticCases.length,
    i18n.language,
  ])

  const recommendedActions = useMemo(() => computeRecommendedActions({
    openFailures: openFailureCount,
    pendingApprovals: waitingNodes.length,
    topClusterFrequency,
    healthScore,
    totalRuns,
  }), [openFailureCount, waitingNodes.length, topClusterFrequency, healthScore, totalRuns, i18n.language])

  // Before the first terminal run, dismissal lasts only for this authenticated
  // store session so a reload restores the Recovery Lab entry. Real history
  // upgrades the same choice to the durable preference operators already had.
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

  const failuresLabel = t('recoveryCenter.metric.failures.label')
  const failuresDisplay = openFailureCount === 0 ? '0' : String(openFailureCount)
  const failuresRationale = openFailureCount === 0
    ? t('recoveryCenter.metric.failures.rationaleEmpty')
    : t('recoveryCenter.metric.failures.rationale')
  const homeTiles: VitalSignsTile[] = [
    {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      label: failuresLabel,
      display: failuresDisplay,
      numericValue: openFailureCount,
      severity: openFailureCount === 0 ? 'healthy' : openFailureCount > 5 ? 'unhealthy' : 'warn',
      rationale: failuresRationale,
      ariaLabel: t('recoveryCenter.metric.aria', { label: failuresLabel, display: failuresDisplay, rationale: failuresRationale }),
      onClick: props.onOpenRecoveryQueue,
      testId: 'recovery-center-metric-failures',
    },
  ]
  // Append the computed tiles. Each pushes a fully-formed VitalSignsTile;
  // the inline composition keeps the rich aria-label (label + display + rationale)
  // the legacy RecoveryCenterMetric provided to screen readers.
  const recoveryTime = metrics ? selectRecoveryTimeMetric(metrics) : null
  const recoveryTimeLabel = t('recoveryCenter.metric.mttr.label')
  const recoveryTimeDisplay = recoveryTime?.display ?? '—'
  const recoveryTimeRationale = recoveryTime
    ? tRecoveryMetricRationale(recoveryTime)
    : t('recoveryCenter.metric.mttr.rationaleFallback')
  // The recovery trend needs at least two daily points to tell a story. The hover
  // title lists the exact per-day values the sparkline plots.
  const mttrTrend = metrics?.mttrTrend ?? []
  const mttrTrendSeconds = mttrTrend.map((point) => point.seconds)
  const mttrTrendPointLabels = mttrTrend.map(
    (point) => `${point.day}: ${formatDowntime(point.seconds * 1000)}`,
  )
  const mttrTrendTitle = mttrTrendPointLabels.join('\n')
  homeTiles.push({
    icon: <RefreshCw size={14} aria-hidden="true" />,
    label: recoveryTimeLabel,
    display: recoveryTimeDisplay,
    numericValue: recoveryTime?.value ?? null,
    severity: recoveryTime?.severity ?? 'neutral',
    rationale: recoveryTimeRationale,
    ariaLabel: t('recoveryCenter.metric.aria', {
      label: recoveryTimeLabel,
      display: recoveryTimeDisplay,
      rationale: recoveryTimeRationale,
    }),
    sparkline: mttrTrendSeconds.length >= 2 ? mttrTrendSeconds : undefined,
    sparklineLabel: t('recoveryCenter.metric.mttr.trendAria', { count: mttrTrendSeconds.length }),
    sparklineTitle: mttrTrendSeconds.length >= 2 ? mttrTrendTitle : undefined,
    sparklinePointLabels: mttrTrendSeconds.length >= 2 ? mttrTrendPointLabels : undefined,
    onSelectSparklinePoint: mttrTrendSeconds.length >= 2
      ? (index) => {
          const day = mttrTrend[index]?.day
          if (!day) return
          requestRecoveryDayFocus(day)
          props.onOpenTab('recover')
        }
      : undefined,
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-verified-recovery',
  })
  const firstActionLabel = t('recoveryCenter.metric.firstAction.label')
  const firstActionDisplay = metrics?.timeToFirstAction?.display ?? '—'
  const firstActionRationale = metrics?.timeToFirstAction
    ? tRecoveryMetricRationale(metrics.timeToFirstAction)
    : t('recoveryCenter.metric.firstAction.rationaleFallback')
  homeTiles.push({
    icon: <Hourglass size={14} aria-hidden="true" />,
    label: firstActionLabel,
    display: firstActionDisplay,
    numericValue: metrics?.timeToFirstAction?.value ?? null,
    severity: metrics?.timeToFirstAction?.severity ?? 'neutral',
    rationale: firstActionRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: firstActionLabel, display: firstActionDisplay, rationale: firstActionRationale }),
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-first-action',
  })
  const approvalsLabel = t('recoveryCenter.metric.approvals.label')
  const approvalsDisplay = waitingNodes.length === 0 ? '0' : String(waitingNodes.length)
  const approvalsRationale = waitingNodes.length === 0
    ? t('recoveryCenter.metric.approvals.rationaleEmpty')
    : t('recoveryCenter.metric.approvals.rationale')
  homeTiles.push({
    icon: <Users size={14} aria-hidden="true" />,
    label: approvalsLabel,
    display: approvalsDisplay,
    numericValue: waitingNodes.length,
    severity: waitingNodes.length === 0 ? 'healthy' : 'warn',
    rationale: approvalsRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: approvalsLabel, display: approvalsDisplay, rationale: approvalsRationale }),
    onClick: () => props.onOpenTab('recover'),
    testId: 'recovery-center-metric-approvals',
  })
  const replayLabel = t('recoveryCenter.metric.replay.label')
  const replayDisplay = metrics?.replayRate.display ?? '—'
  const replayRationale = metrics?.replayRate
    ? tRecoveryMetricRationale(metrics.replayRate)
    : t('recoveryCenter.metric.replay.rationaleFallback')
  homeTiles.push({
    icon: <Zap size={14} aria-hidden="true" />,
    label: replayLabel,
    display: replayDisplay,
    numericValue: metrics?.replayRate.value ?? null,
    severity: metrics?.replayRate.severity ?? 'neutral',
    rationale: replayRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: replayLabel, display: replayDisplay, rationale: replayRationale }),
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-replay',
  })
  const durabilityLabel = t('recoveryCenter.metric.durability.label')
  const durabilityDisplay = metrics?.recurrenceRate?.display ?? '—'
  const durabilityRationale = metrics?.recurrenceRate
    ? tRecoveryMetricRationale(metrics.recurrenceRate)
    : t('recoveryCenter.metric.durability.rationaleFallback')
  homeTiles.push({
    icon: <ShieldCheck size={14} aria-hidden="true" />,
    label: durabilityLabel,
    display: durabilityDisplay,
    numericValue: metrics?.recurrenceRate?.value ?? null,
    progressValue: metrics?.recurrenceRate?.value ?? null,
    severity: metrics?.recurrenceRate?.severity ?? 'neutral',
    rationale: durabilityRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: durabilityLabel, display: durabilityDisplay, rationale: durabilityRationale }),
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-durability',
  })
  const slaLabel = t('recoveryCenter.metric.sla.label')
  const slaDisplay = metrics?.slaAttainment?.display ?? '—'
  const slaRationale = metrics?.slaAttainment
    ? tRecoveryMetricRationale(metrics.slaAttainment)
    : t('recoveryCenter.metric.sla.rationaleFallback')
  homeTiles.push({
    icon: <Target size={14} aria-hidden="true" />,
    label: slaLabel,
    display: slaDisplay,
    numericValue: metrics?.slaAttainment?.value ?? null,
    severity: metrics?.slaAttainment?.severity ?? 'neutral',
    rationale: slaRationale,
    ariaLabel: t('recoveryCenter.metric.aria', { label: slaLabel, display: slaDisplay, rationale: slaRationale }),
    onClick: () => props.onOpenTab('operations'),
    testId: 'recovery-center-metric-sla',
  })
  const metricStrip = (
    <VitalSignsStrip
      tiles={withSeverityLabels(homeTiles, t)}
      ariaLabel={t('recoveryCenter.metricStripAria')}
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
        allClear={allClear && recoveryClearEligible}
        allClearDowntimeMs={allClearDowntimeOverride ?? metrics?.downtimeEndedMs}
        celebrationTrigger={celebrationTrigger}
        personalWins={operatorWins}
        memoryPurgeCountdown={memoryPurgeCountdownLabel}
        onOpenMemoryGovernance={() => {
          void import('./operations-section-bus')
            .then(({ requestOperationsSection }) => {
              requestOperationsSection('access')
              props.onOpenTab('operations')
            })
            .catch(() => props.onOpenTab('operations'))
        }}
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
          props.onOpenTab('recover')
        }}
      />

      <div className="we-operator-grid">
        <section className="we-operator-chat">
          <RecoveryCenterComposer
            onOpenTab={props.onOpenTab}
            recentDlqRunId={openDeadLetters[0]?.runId}
          />
          {showOnboarding && (
            <RecoveryLabEntry
              onOpenStudio={() => props.onOpenTab('copilot')}
              onOpenRecipes={() => props.onOpenTab('templates')}
              onStartDrill={props.onStartRecoveryDrill}
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
          <SemanticRecoveryCasesTile
            cases={semanticCases}
            loading={semanticCasesLoading}
            unavailable={semanticCasesUnavailable}
            onOpenRun={props.onOpenRun}
            onOpenCase={props.onOpenRecoveryCase}
          />
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

      <RecoveryValidationSection report={validation} />

      <ValueDashboardSection
        recoveryTimeMs={recoveryTime?.value ?? null}
        recoveryTimeDisplay={recoveryTime?.display ?? '—'}
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
