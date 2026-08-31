/** Home recovery controller for independently settled tenant and identity snapshots. */

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import type { DeadLetter } from './dead-letter-types'
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { RecoveryCenterView } from './RecoveryCenterView'
import type { RecoveryValidationReport } from './RecoveryValidationSection'
import { requestOperationsSection } from './operations-section-bus'
import {
  buildGreeting,
  buildHeatmapCells,
  computeLongestOpenDowntime,
  computeStreaks,
  decodeOperatorBrief,
  listActiveRuns,
  presentOperatorBrief,
  readDisplayName,
  readHealthScore,
  shouldShowOnboarding,
  type ClustersResponse,
  type HeatmapDay,
  type OperatorWins,
  type OperatorBrief,
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

export type RecoveryCenterPanelProps = {
  runs: RunSummary[]
  runNodes: RunNode[]
  deadLetters: DeadLetter[]
  onSemanticBlockerRunsChange?: (runIds: string[]) => void
  onOpenTab: (tab: ActiveTab) => void
  onOpenRecoveryCase: (caseId: string) => void
  onOpenRun: (runId: string, targetTab?: ActiveTab) => void | Promise<void>
  onOpenRecoveryQueue: (deadLetterId?: string) => void
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
type OperatorBriefStatus = 'loading' | 'available' | 'unavailable'

const RECOVERY_IMPACT_ACTIVE_POLL_MS = 10_000
const RECOVERY_IMPACT_IDLE_POLL_MS = 60_000

function useRecoveryCenterController(props: RecoveryCenterPanelProps) {
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
  const [operatorBriefSnapshot, setOperatorBriefSnapshot] = useState<OrgSnapshot<{
    brief: OperatorBrief | null
    status: OperatorBriefStatus
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
  const operatorBrief = operatorBriefSnapshot?.orgId === resolvedOrgId
    ? operatorBriefSnapshot.value.brief
    : null
  const operatorBriefStatus = operatorBriefSnapshot?.orgId === resolvedOrgId
    ? operatorBriefSnapshot.value.status
    : 'loading'
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
          throw new Error(t('recoveryCenter.invalidHomeResponse'))
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
    let cancelled = false
    setOperatorBriefSnapshot({
      orgId: resolvedOrgId,
      value: { brief: null, status: 'loading' },
    })
    void api('/operations/brief')
      .then((payload) => {
        if (cancelled) return
        const brief = decodeOperatorBrief(payload)
        if (!brief) throw new Error('invalid operator brief')
        setOperatorBriefSnapshot({
          orgId: resolvedOrgId,
          value: { brief, status: 'available' },
        })
      })
      .catch(() => {
        if (cancelled) return
        setOperatorBriefSnapshot({
          orgId: resolvedOrgId,
          value: { brief: null, status: 'unavailable' },
        })
      })
    return () => { cancelled = true }
  }, [platformVersion, resolvedOrgId])

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
      })
    return () => { cancelled = true }
  }, [applyImpactSnapshot, impactPollVersion])

  const openDeadLetters = useMemo(
    () => props.deadLetters.filter((dlq) => dlq.status === 'open'),
    [props.deadLetters],
  )
  const currentQueueOverview = queueOverview?.orgId === resolvedOrgId ? queueOverview : null
  const unobservedVisibleFailures = currentQueueOverview
    ? openDeadLetters.filter((deadLetter) => !currentQueueOverview.observedOpenIds.includes(deadLetter.id)).length
    : openDeadLetters.length
  const openFailureCount = Math.max(currentQueueOverview?.openCount ?? 0, unobservedVisibleFailures)
  const recoveryClearEligible = openFailureCount === 0 && semanticOutcomePosture === 'clear'

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

  useEffect(() => {
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [platformVersion, openFailureCount])

  const waitingNodes = useMemo(
    () => props.runNodes.filter((node) => node.status === 'waiting'),
    [props.runNodes],
  )
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

  const recommendedActions = useMemo(
    () => presentOperatorBrief(operatorBrief),
    [operatorBrief, i18n.language],
  )
  const allActiveRuns = useMemo(
    () => listActiveRuns(props.runs, props.runs.length),
    [props.runs],
  )
  const activeRuns = allActiveRuns.slice(0, 3)
  const handleRecommendedAction = useCallback((action: RecommendedAction) => {
    const { target } = action
    if (target.destination === 'recoveryCase') {
      props.onOpenRecoveryCase(target.id)
    } else if (target.destination === 'runs') {
      if (target.runId) void props.onOpenRun(target.runId, 'runs')
      else props.onOpenTab('runs')
    } else if (target.destination === 'recover') {
      props.onOpenRecoveryQueue(target.kind === 'dead_letter' ? target.id : undefined)
    } else if (target.destination === 'operations') {
      props.onOpenTab('operations')
    }
  }, [
    props.onOpenRecoveryCase,
    props.onOpenRecoveryQueue,
    props.onOpenRun,
    props.onOpenTab,
  ])

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

  const metricsStatus: 'loading' | 'unavailable' | 'available' = metricsLoading || semanticCasesStatus === 'loading'
    ? 'loading'
    : metricsError || semanticCasesStatus === 'unavailable'
      ? 'unavailable'
      : metrics
        ? 'available'
        : 'loading'

  const openMemoryGovernance = useCallback(() => {
    requestOperationsSection('access')
    props.onOpenTab('operations')
  }, [props.onOpenTab])

  return {
    activeRuns, allActiveRuns, allClear, allClearDowntimeOverride, bumpPlatformVersion,
    celebrationTrigger, clusters, dismissIntro, greeting, handleRecommendedAction,
    healthScore, heatmap, heatmapCells, insightsOpen, ledger, longestOpen, memoryPurgeCountdownLabel,
    metrics, metricsError, metricsLoading, metricsStatus, nowMs,
    onOpenActivity: () => props.onOpenTab('runs'), onOpenMemoryGovernance: openMemoryGovernance,
    onOpenRecoveryQueue: props.onOpenRecoveryQueue,
    onOpenRun: (runId: string) => props.onOpenRun(runId, 'runs'), onOpenTab: props.onOpenTab,
    onStartRecoveryDrill: props.onStartRecoveryDrill, openDeadLetters, openFailureCount,
    operatorBriefStatus, operatorBriefWarnings: operatorBrief?.warnings ?? [], operatorWins,
    recommendedActions, recoveryClearEligible, setInsightsOpen, showOnboarding,
    streak, validation, waitingNodes,
  }
}

export type RecoveryCenterController = ReturnType<typeof useRecoveryCenterController>

export function RecoveryCenterPanel(props: RecoveryCenterPanelProps) {
  return <RecoveryCenterView model={useRecoveryCenterController(props)} />
}
