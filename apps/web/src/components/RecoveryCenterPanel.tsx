/**
 * Home — the authenticated operational landing page.
 *
 * The primary surface answers two questions: what needs attention now, and
 * what is still running. Onboarding supplies only the next incomplete setup
 * outcome. Recovery trends, validation, calibration, cost, and the assistant
 * remain available behind one lazy-loaded insights disclosure.
 *
 * This file owns the coalesced data orchestration. Presentational pieces live
 * under `./recovery-center/`: the compact header, action workspace, and
 * secondary insights. Keeping the action model pure makes priority ordering
 * deterministic and independently testable.
 *
 * Data sources:
 * - `GET /recovery/home` → one coalesced snapshot for recovery metrics,
 *   validation, clusters, semantic cases, lifetime/operator impact, heatmap,
 *   and the authoritative queue overview.
 * - `GET /recovery/home?scope=impact` → a lightweight convergence snapshot for
 *   the ledger, personal wins, and queue while background work completes.
 * - Run nodes and the bounded run projection → pending human work.
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
 * Design language: see the Home and Recovery Center blocks in
 * `apps/web/src/styles/platform.css`. Tokens-only, no inline hex. Animations
 * honour `prefers-reduced-motion`. Tab order: header → priority inbox →
 * active work → onboarding → insights.
 */

import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDown } from 'lucide-react'
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
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import type { RecoveryValidationReport } from './RecoveryValidationSection'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { OnboardingBanner } from './OnboardingBanner'
import {
  buildGreeting,
  buildHeatmapCells,
  computeLongestOpenDowntime,
  computeRecommendedActions,
  computeStreaks,
  downtimeSeverity,
  listActiveRuns,
  readDisplayName,
  readHealthScore,
  shouldShowOnboarding,
  type ClustersResponse,
  type HeatmapDay,
  type OperatorWins,
  type RecoveryLedger,
  type RecoveryMetrics,
  type RecommendedAction,
} from './recovery-center/recovery-center-model'
import {
  consumeRecoveryAllClear,
  parseRecoveryAllClearEvent,
  RECOVERY_ALL_CLEAR_EVENT,
  RECOVERY_ALL_CLEAR_WINDOW_MS,
  type RecoveryAllClearRequest,
} from './recovery-all-clear-bus'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { HomeActionWorkspace } from './recovery-center/HomeActionWorkspace'

const HomeInsights = lazy(() => import('./recovery-center/HomeInsights').then((module) => ({
  default: module.HomeInsights,
})))

type RecoveryCenterPanelProps = {
  runs: RunSummary[]
  runNodes: RunNode[]
  deadLetters: DeadLetter[]
  /** Keep the global recovery posture synchronized with durable semantic containment. */
  onSemanticBlockerRunsChange?: (runIds: string[]) => void
  onOpenTab: (tab: ActiveTab) => void
  onOpenRecoveryCase: (caseId: string) => void
  onOpenRun: (runId: string, targetTab?: ActiveTab) => void | Promise<void>
  /** Open Activity and optionally select one exact recovery row. */
  onOpenRecoveryQueue: (deadLetterId?: string) => void
  /** Start a deterministic drill so a fresh operator can try the recovery loop for real. */
  onStartRecoveryDrill?: () => void | Promise<void>
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
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
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
  const [insightsOpen, setInsightsOpen] = useState(false)
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
    setInsightsOpen(false)
  }, [resolvedOrgId, resolvedUserId])
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
    semanticCases: semanticCases.length,
    topClusterFrequency,
    healthScore,
  }), [
    openFailureCount,
    waitingNodes.length,
    semanticCases.length,
    topClusterFrequency,
    healthScore,
    i18n.language,
  ])
  const allActiveRuns = useMemo(
    () => listActiveRuns(props.runs, props.runs.length),
    [props.runs],
  )
  const activeRuns = allActiveRuns.slice(0, 3)
  const handleRecommendedAction = useCallback((action: RecommendedAction) => {
    if (action.id === 'resolve_approvals') {
      const waitingRun = props.runs.find(
        (run) => run.status === 'waiting' || run.hasWaitingNodes,
      )
      if (waitingRun) {
        void props.onOpenRun(waitingRun.id, 'runs')
      } else {
        props.onOpenTab('runs')
      }
      return
    }
    if (action.id === 'review_semantic_cases') {
      const semanticCase = semanticCases[0]
      if (semanticCase) props.onOpenRecoveryCase(semanticCase.id)
      else props.onOpenTab('runs')
      return
    }
    if (action.id === 'triage_failures') {
      props.onOpenRecoveryQueue(openDeadLetters[0]?.id)
      return
    }
    props.onOpenTab('operations')
  }, [
    openDeadLetters,
    props.onOpenRecoveryCase,
    props.onOpenRecoveryQueue,
    props.onOpenRun,
    props.onOpenTab,
    props.runs,
    semanticCases,
  ])

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

  const metricsStatus = metricsLoading || semanticCasesStatus === 'loading'
    ? 'loading'
    : metricsError || semanticCasesStatus === 'unavailable'
      ? 'unavailable'
      : metrics
        ? 'available'
        : 'loading'

  return (
    <div className="we-recovery-center-panel we-recovery-center-panel--operator">
      <RecoveryCenterHero
        salutation={greeting.salutation}
        subline={greeting.subline}
        healthScore={healthScore}
        openFailures={openFailureCount}
        priorityCount={recommendedActions.length}
        metricsStatus={metricsStatus}
        streak={streak}
        longestOpenMs={longestOpen?.durationMs}
        longestOpenSeverity={downtimeSeverity(longestOpen?.createdAt, nowMs)}
        allClear={allClear && recoveryClearEligible}
        allClearDowntimeMs={allClearDowntimeOverride ?? metrics?.downtimeEndedMs}
        celebrationTrigger={celebrationTrigger}
        personalWins={operatorWins}
        memoryPurgeCountdown={memoryPurgeCountdownLabel}
        onRefreshStatus={bumpPlatformVersion}
        onOpenMemoryGovernance={() => {
          void import('./operations-section-bus')
            .then(({ requestOperationsSection }) => {
              requestOperationsSection('access')
              props.onOpenTab('operations')
            })
            .catch(() => props.onOpenTab('operations'))
        }}
      />

      <HomeActionWorkspace
        actions={recommendedActions}
        activeRuns={activeRuns}
        activeRunCount={allActiveRuns.length}
        onSelectAction={handleRecommendedAction}
        onOpenRun={(runId) => props.onOpenRun(runId, 'runs')}
        onOpenActivity={() => props.onOpenTab('runs')}
      />

      <OnboardingBanner onOpenTab={props.onOpenTab} />

      <section className="we-home-insights" data-expanded={insightsOpen}>
        <button
          type="button"
          className="we-home-insights__toggle"
          aria-expanded={insightsOpen}
          aria-controls="we-home-insights-content"
          onClick={() => setInsightsOpen((open) => !open)}
          data-testid="home-insights-toggle"
        >
          <span className="we-home-insights__toggle-copy">
            <strong>{t('home.insights.title')}</strong>
          </span>
          <span className="we-home-insights__toggle-action" aria-hidden="true">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {insightsOpen && (
          <div id="we-home-insights-content">
            <Suspense
              fallback={(
                <p className="helper-text" role="status">
                  {t('common.loading')}
                </p>
              )}
            >
              <HomeInsights
                metrics={metrics}
                openFailureCount={openFailureCount}
                waitingApprovals={waitingNodes.length}
                clusters={clusters}
                heatmap={heatmap}
                heatmapCells={heatmapCells}
                nowMs={nowMs}
                validation={validation}
                ledger={ledger}
                personalWins={operatorWins}
                showRecoveryLab={showOnboarding}
                recentDlqRunId={openDeadLetters[0]?.runId}
                onOpenTab={props.onOpenTab}
                onOpenRecoveryQueue={props.onOpenRecoveryQueue}
                onStartRecoveryDrill={props.onStartRecoveryDrill}
                onDismissRecoveryLab={dismissIntro}
              />
            </Suspense>

            {metricsError && !metricsLoading && (
              <p className="we-recovery-center-error" role="status">
                {t('recoveryCenter.metricsUnavailable', { detail: metricsError })}
              </p>
            )}
          </div>
        )}
      </section>

      <OnboardingReplayButton />
    </div>
  )
}
