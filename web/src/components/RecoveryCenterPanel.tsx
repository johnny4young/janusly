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
import { api, contractApi } from '../api'
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
  homeEvidenceStatus,
  HOME_EVIDENCE_STALE_MS,
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
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { isGetOperationsBriefResponse } from '../lib/api-guards/operations/GetOperationsBrief'

const RECOVERY_CENTER_TAGS = [PLATFORM_TAG, 'recovery', 'runs', 'dlq', 'auto-healing', 'campaigns'] as const
const EMPTY_HEATMAP: HeatmapDay[] = []
const EMPTY_SEMANTIC_CASES: RecoveryCase[] = []

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
  userId: string
  orgId: string
  openCount: number
  oldestOpen: { createdAt?: string } | null
  observedOpenIds: string[]
}

type HomeReadStatus = 'loading' | 'available' | 'unavailable'

const RECOVERY_IMPACT_ACTIVE_POLL_MS = 10_000
const RECOVERY_IMPACT_IDLE_POLL_MS = 60_000

function useRecoveryCenterController(props: RecoveryCenterPanelProps) {
  const { t, i18n } = useT()
  const { onOpenRecoveryCase, onOpenRecoveryQueue, onOpenRun, onOpenTab } = props
  const platformVersion = useInvalidationNonce(RECOVERY_CENTER_TAGS)
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
  const [metricsSnapshot, setMetricsSnapshot] = useState<(OrgSnapshot<RecoveryMetrics> & { receivedAt: number }) | null>(null)
  const [clustersSnapshot, setClustersSnapshot] = useState<OrgSnapshot<ClustersResponse | null> | null>(null)
  const [heatmapSnapshot, setHeatmapSnapshot] = useState<OrgSnapshot<HeatmapDay[]> | null>(null)
  const [validationSnapshot, setValidationSnapshot] = useState<OrgSnapshot<RecoveryValidationReport | null> | null>(null)
  const [semanticCasesSnapshot, setSemanticCasesSnapshot] = useState<OrgSnapshot<{
    cases: RecoveryCase[]
    status: HomeReadStatus
  }> | null>(null)
  const [operatorBriefSnapshot, setOperatorBriefSnapshot] = useState<IdentitySnapshot<{
    brief: OperatorBrief | null
    status: HomeReadStatus
  }> | null>(null)
  const [ledgerSnapshot, setLedgerSnapshot] = useState<OrgSnapshot<RecoveryLedger | null> | null>(null)
  const [winsSnapshot, setWinsSnapshot] = useState<IdentitySnapshot<OperatorWins | null> | null>(null)
  const [impactPollVersion, setImpactPollVersion] = useState(0)
  const metrics = metricsSnapshot?.orgId === resolvedOrgId ? metricsSnapshot.value : null
  const clusters = clustersSnapshot?.orgId === resolvedOrgId ? clustersSnapshot.value : null
  const heatmap = heatmapSnapshot?.orgId === resolvedOrgId ? heatmapSnapshot.value : EMPTY_HEATMAP
  const validation = validationSnapshot?.orgId === resolvedOrgId ? validationSnapshot.value : undefined
  const semanticCases = semanticCasesSnapshot?.orgId === resolvedOrgId
    ? semanticCasesSnapshot.value.cases
    : EMPTY_SEMANTIC_CASES
  const semanticCasesStatus = semanticCasesSnapshot?.orgId === resolvedOrgId
    ? semanticCasesSnapshot.value.status
    : 'loading'
  const semanticOutcomePosture = semanticCases.length > 0
    ? 'attention'
    : semanticCasesStatus === 'available'
      ? 'clear'
      : semanticCasesStatus
  const operatorBrief = operatorBriefSnapshot?.orgId === resolvedOrgId && operatorBriefSnapshot.userId === resolvedUserId
    ? operatorBriefSnapshot.value.brief
    : null
  const operatorBriefStatus = operatorBriefSnapshot?.orgId === resolvedOrgId && operatorBriefSnapshot.userId === resolvedUserId
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
  const publishedSemanticBlockersRef = useRef<{
    listener: NonNullable<RecoveryCenterPanelProps['onSemanticBlockerRunsChange']>
    runIds: string[]
  } | null>(null)
  const ledger = ledgerSnapshot?.orgId === resolvedOrgId ? ledgerSnapshot.value : null
  const operatorWins = winsSnapshot?.orgId === resolvedOrgId && winsSnapshot.userId === resolvedUserId
    ? winsSnapshot.value
    : null
  const [queueOverview, setQueueOverview] = useState<RecoveryQueueOverview | null>(null)
  const [queueStatusSnapshot, setQueueStatusSnapshot] = useState<IdentitySnapshot<HomeReadStatus> | null>(null)
  const queueStatus = queueStatusSnapshot?.orgId === resolvedOrgId && queueStatusSnapshot.userId === resolvedUserId
    ? queueStatusSnapshot.value : 'loading'
  // Full and impact reads overlap. Only the latest requested impact projection
  // may replace the queue/ledger, including their availability.
  const impactReadGeneration = useRef(0)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [metricsErrorSnapshot, setMetricsErrorSnapshot] = useState<OrgSnapshot<string> | null>(null)
  const metricsError = metricsErrorSnapshot?.orgId === resolvedOrgId
    ? metricsErrorSnapshot.value
    : null
  const [currentHour, setCurrentHour] = useState(12)
  const [nowMs, setNowMs] = useState<number | null>(null)
  const [staleRefreshNonce, setStaleRefreshNonce] = useState(0)
  const staleRefreshReceivedAtRef = useRef<number | null>(null)
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
    const listener = props.onSemanticBlockerRunsChange
    if (!listener) {
      publishedSemanticBlockersRef.current = null
      return
    }
    const published = publishedSemanticBlockersRef.current
    if (published?.listener === listener
      && published.runIds.length === semanticBlockerRunIds.length
      && published.runIds.every((runId, index) => runId === semanticBlockerRunIds[index])) {
      return
    }
    publishedSemanticBlockersRef.current = { listener, runIds: semanticBlockerRunIds }
    listener(semanticBlockerRunIds)
  }, [props.onSemanticBlockerRunsChange, semanticBlockerRunIds])

  const pendingVerifiedRecoveryRef = useRef<{
    orgId: string
    totalRecovered: number
    downtimeMs: number
  } | null>(null)
  const dismissIntro = dismissIntroThisSession

  const applyImpactSnapshot = useCallback((
    snapshot: RecoveryHomeSnapshot,
    orgId: string,
    userId: string,
    generation: number,
  ) => {
    if (generation !== impactReadGeneration.current) return
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
      setQueueStatusSnapshot({ orgId, userId, value: queueValue ? 'available' : 'unavailable' })
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
          orgId, userId,
          openCount: open,
          oldestOpen: queueValue.oldestOpen,
          observedOpenIds: [...observedOpenIdsRef.current],
        })
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    // Each refresh owns its request: a manual retry must not reuse a rejected
    // promise from the API client's short GET deduplication window.
    const controller = new AbortController()
    const generation = ++impactReadGeneration.current
    setQueueStatusSnapshot({ orgId: resolvedOrgId, userId: resolvedUserId, value: 'loading' })
    setMetricsLoading(true)
    setMetricsErrorSnapshot(null)
    setSemanticCasesSnapshot(current => ({
      orgId: resolvedOrgId,
      value: {
        cases: current?.orgId === resolvedOrgId ? current.value.cases : [],
        status: 'loading',
      },
    }))

    void api('/recovery/home', { signal: controller.signal })
      .then((payload) => {
        if (cancelled) return
        const snapshot = parseRecoveryHomeSnapshot(payload)
        if (!snapshot || snapshot.scope !== 'full') {
          throw new Error(runtimeT('recoveryCenter.invalidHomeResponse'))
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
          setMetricsSnapshot({ orgId: resolvedOrgId, value: metricsValue, receivedAt: Date.now() })
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
        applyImpactSnapshot(snapshot, resolvedOrgId, resolvedUserId, generation)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (generation === impactReadGeneration.current) {
          setQueueStatusSnapshot({ orgId: resolvedOrgId, userId: resolvedUserId, value: 'unavailable' })
        }
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
          if (generation === impactReadGeneration.current) {
            setLedgerSnapshot({ orgId: resolvedOrgId, value: null })
            setWinsSnapshot({ orgId: resolvedOrgId, userId: resolvedUserId, value: null })
          }
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

    return () => { cancelled = true; controller.abort() }
  }, [applyImpactSnapshot, platformVersion, resolvedOrgId, resolvedUserId, staleRefreshNonce])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setOperatorBriefSnapshot({
      orgId: resolvedOrgId, userId: resolvedUserId,
      value: { brief: null, status: 'loading' },
    })
    void contractApi('GET /operations/brief', '/operations/brief', undefined, { signal: controller.signal, guard: isGetOperationsBriefResponse })
      .then((payload) => {
        if (cancelled) return
        const brief = decodeOperatorBrief(payload)
        if (!brief) throw new Error('invalid operator brief')
        setOperatorBriefSnapshot({
          orgId: resolvedOrgId, userId: resolvedUserId,
          value: { brief, status: 'available' },
        })
      })
      .catch(() => {
        if (cancelled) return
        setOperatorBriefSnapshot({
          orgId: resolvedOrgId, userId: resolvedUserId,
          value: { brief: null, status: 'unavailable' },
        })
      })
    return () => { cancelled = true; controller.abort() }
  }, [platformVersion, resolvedOrgId, resolvedUserId])

  useEffect(() => {
    if (impactPollVersion === 0) return
    const controller = new AbortController()
    const generation = ++impactReadGeneration.current
    const orgId = resolvedOrgId
    const userId = resolvedUserId
    void api('/recovery/home?scope=impact', { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return
        const snapshot = parseRecoveryHomeSnapshot(payload)
        if (!snapshot || snapshot.scope !== 'impact') throw new Error('invalid recovery impact')
        applyImpactSnapshot(snapshot, orgId, userId, generation)
      })
      .catch(() => {
        if (!controller.signal.aborted && generation === impactReadGeneration.current) {
          setQueueStatusSnapshot({ orgId, userId, value: 'unavailable' })
        }
      })
    return () => { controller.abort() }
  }, [applyImpactSnapshot, impactPollVersion, resolvedOrgId, resolvedUserId])

  const openDeadLetters = useMemo(
    () => props.deadLetters.filter((dlq) => dlq.status === 'open'),
    [props.deadLetters],
  )
  const currentQueueOverview = queueOverview?.orgId === resolvedOrgId && queueOverview.userId === resolvedUserId ? queueOverview : null
  const unobservedVisibleFailures = currentQueueOverview
    ? openDeadLetters.filter((deadLetter) => !currentQueueOverview.observedOpenIds.includes(deadLetter.id)).length
    : openDeadLetters.length
  const openFailureCount = Math.max(currentQueueOverview?.openCount ?? 0, unobservedVisibleFailures)
  const metricsAgeMs = metricsSnapshot && nowMs !== null ? Math.max(0, nowMs - metricsSnapshot.receivedAt) : 0
  const metricsStatus = homeEvidenceStatus({
    metrics,
    loading: metricsLoading || semanticCasesStatus === 'loading' || operatorBriefStatus === 'loading' || queueStatus === 'loading',
    unavailable: Boolean(metricsError),
    incomplete: semanticCasesStatus === 'unavailable' || operatorBriefStatus === 'unavailable'
      || queueStatus === 'unavailable' || (operatorBrief?.warnings.length ?? 0) > 0,
    ageMs: metricsAgeMs,
  })
  const staleSampleReceivedAt = metrics && !metricsLoading && metricsAgeMs >= HOME_EVIDENCE_STALE_MS
    ? metricsSnapshot?.receivedAt ?? null
    : null
  // One background refresh per aged sample; a failed refresh keeps the stale
  // label and Retry until a later successful read replaces receivedAt.
  useEffect(() => {
    if (staleSampleReceivedAt === null || staleRefreshReceivedAtRef.current === staleSampleReceivedAt) return
    staleRefreshReceivedAtRef.current = staleSampleReceivedAt
    setStaleRefreshNonce((nonce) => nonce + 1)
  }, [staleSampleReceivedAt])
  const recoveryClearEligible = metricsStatus === 'available' && openFailureCount === 0 && semanticOutcomePosture === 'clear'

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

  const healthScore = metricsStatus === 'available' ? readHealthScore(metrics) : null
  // These helpers translate via the stable runtimeT function, which reads the
  // current locale outside React. The explicit language key invalidates both
  // projections when useT observes a locale switch.
  /* oxlint-disable react/exhaustive-deps -- runtimeT reads locale through the i18n runtime */
  const greeting = useMemo(() => buildGreeting({
    hour: currentHour,
    displayName: readDisplayName(user),
    openFailures: openFailureCount,
    pendingApprovals: waitingNodes.length,
    healthScore,
    evidenceStatus: metricsStatus,
    semanticOutcomePosture,
    semanticCaseCount: semanticCases.length,
  }), [
    currentHour,
    user,
    openFailureCount,
    waitingNodes.length,
    healthScore,
    metricsStatus,
    semanticOutcomePosture,
    semanticCases.length,
    i18n.language,
  ])

  const recommendedActions = useMemo(
    () => presentOperatorBrief(operatorBrief),
    [operatorBrief, i18n.language],
  )
  /* oxlint-enable react/exhaustive-deps */
  const allActiveRuns = useMemo(
    () => listActiveRuns(props.runs, props.runs.length),
    [props.runs],
  )
  const activeRuns = allActiveRuns.slice(0, 3)
  const handleRecommendedAction = useCallback((action: RecommendedAction) => {
    const { target } = action
    if (target.destination === 'recoveryCase') {
      onOpenRecoveryCase(target.id)
    } else if (target.destination === 'runs') {
      if (target.runId) void onOpenRun(target.runId, 'runs')
      else onOpenTab('runs')
    } else if (target.destination === 'recover') {
      onOpenRecoveryQueue(target.kind === 'dead_letter' ? target.id : undefined)
    } else if (target.destination === 'operations') {
      onOpenTab('operations')
    }
  }, [onOpenRecoveryCase, onOpenRecoveryQueue, onOpenRun, onOpenTab])

  const showOnboarding = metricsStatus === 'empty'
    && semanticCases.length === 0
    && recommendedActions.length === 0
    && operatorBriefStatus === 'available'
    && operatorBrief?.warnings.length === 0
    && shouldShowOnboarding({
      runs: props.runs.length,
      openFailures: openFailureCount,
      waitingApprovals: waitingNodes.length,
      dismissed: introDismissedThisSession,
    })

  const openMemoryGovernance = useCallback(() => {
    requestOperationsSection('access')
    onOpenTab('operations')
  }, [onOpenTab])

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
