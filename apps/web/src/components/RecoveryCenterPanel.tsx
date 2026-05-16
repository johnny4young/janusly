/**
 * Recovery Center — the authenticated landing page.
 *
 * Composes recovery signals from existing endpoints into a one-screen
 * summary: a hero strip with the org-wide health ring + greeting, a
 * four-cell metric strip (open failures / MTTR / approvals / replay),
 * four content tiles (recovery queue / failure clusters / pending
 * approvals / recommended actions), and a generous empty-state hero
 * for new operators.
 *
 * Data sources (all already shipped):
 * - `GET /recovery/metrics` → metric strip, health badge, severities.
 * - `GET /dlq?status=open` → recovery-queue tile.
 * - `GET /dlq/clusters` → failure-clusters tile.
 * - Run nodes from the store (`status === "waiting"`) → pending approvals.
 *
 * The Recovery Center is pure composition — no API additions, no engine change.
 * Each child tile refetches independently on the cross-panel
 * `platformVersion` tick (same pattern OperationsPanel uses today).
 *
 * Used by `App.tsx` for `activeTab === 'home'`.
 *
 * Design language: see the `Recovery Center` block in
 * `apps/web/src/index.css`. Tokens-only, no inline hex. Animations
 * honour `prefers-reduced-motion`. Tab order: hero → metric strip →
 * tiles → recommended actions → empty-state CTAs.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Check,
  CheckSquare,
  ChevronRight,
  CircleCheck,
  Coins,
  Compass,
  DollarSign,
  Eye,
  FileDiff,
  FlaskConical,
  Gauge,
  Inbox,
  Layers,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Wand2,
  Workflow,
  Zap,
} from 'lucide-react'
import type { ActiveTab, JsonObject, RunNode, RunSummary } from '../types'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'
import { tRecoveryMetricRationale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { BrandMark } from './BrandMark'

// ─────────────────────────────────────────────────────────────────────────
// Types / data shapes — mirror the API envelopes the existing panels read.
// ─────────────────────────────────────────────────────────────────────────

type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

type RecoveryMetrics = {
  successRate: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  windowDays: number
  terminalRuns: number
}

type ClusterCategory =
  | 'secret_missing'
  | 'http_error'
  | 'network_timeout'
  | 'ai_provider'
  | 'parse_error'
  | 'tool_input'
  | 'unknown'

type ClusterOwner = 'ops' | 'workflow_author' | 'platform'

type FailureCluster = {
  signature: string
  category: ClusterCategory
  frequency: number
  suggestedOwner: ClusterOwner
  lastSeen: string
}

type ClustersResponse = {
  clusters: FailureCluster[]
  totalSamples: number
  windowDays: number
}

type RecoveryCenterPanelProps = {
  runs: RunSummary[]
  runNodes: RunNode[]
  deadLetters: DeadLetter[]
  activeRunId: string | null
  onOpenTab: (tab: ActiveTab) => void
  onOpenRun: (runId: string) => void | Promise<void>
  onApproveNode: (nodeId: string) => void | Promise<void>
  onSubmitHumanForm: (nodeId: string, input: JsonObject) => void | Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────
// HealthRing — small SVG donut visualization. Colour reflects the health
// band: cobalt ≥80, amber 60-79, red <60. Animation honours
// prefers-reduced-motion.
// ─────────────────────────────────────────────────────────────────────────

const HEALTH_RING_SIZE = 96
const HEALTH_RING_STROKE = 9
const HEALTH_RING_CIRCUMFERENCE = 2 * Math.PI * ((HEALTH_RING_SIZE - HEALTH_RING_STROKE) / 2)

function healthBand(score: number | null): 'high' | 'mid' | 'low' | 'unknown' {
  if (score === null || Number.isNaN(score)) return 'unknown'
  if (score >= 80) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

function HealthRing({ score }: { score: number | null }) {
  const { t } = useT()
  const band = healthBand(score)
  const reducedMotion = usePrefersReducedMotion()
  const target = score ?? 0
  const animated = useAnimatedNumber(target, 800, reducedMotion)
  const ratio = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100
  const dashoffset = HEALTH_RING_CIRCUMFERENCE * (1 - ratio)
  const radius = (HEALTH_RING_SIZE - HEALTH_RING_STROKE) / 2
  const ariaLabel = score === null
    ? t('recoveryCenter.healthRing.aria.pending')
    : t('recoveryCenter.healthRing.aria.value', { score })
  return (
    <div className="we-recovery-center-ring" data-band={band} aria-label={ariaLabel}>
      <svg width={HEALTH_RING_SIZE} height={HEALTH_RING_SIZE} viewBox={`0 0 ${HEALTH_RING_SIZE} ${HEALTH_RING_SIZE}`} role="img" aria-hidden="true">
        <circle
          cx={HEALTH_RING_SIZE / 2}
          cy={HEALTH_RING_SIZE / 2}
          r={radius}
          className="we-recovery-center-ring__track"
          strokeWidth={HEALTH_RING_STROKE}
          fill="none"
        />
        <circle
          cx={HEALTH_RING_SIZE / 2}
          cy={HEALTH_RING_SIZE / 2}
          r={radius}
          className="we-recovery-center-ring__arc"
          strokeWidth={HEALTH_RING_STROKE}
          fill="none"
          strokeDasharray={HEALTH_RING_CIRCUMFERENCE}
          strokeDashoffset={dashoffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${HEALTH_RING_SIZE / 2} ${HEALTH_RING_SIZE / 2})`}
        />
      </svg>
      <div className="we-recovery-center-ring__label">
        <strong className="we-recovery-center-ring__value">{score === null ? '—' : Math.round(animated)}</strong>
        <small className="we-recovery-center-ring__caption">{t('recoveryCenter.healthRing.caption')}</small>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// useAnimatedNumber — rAF-driven count-up. Snaps when reduced-motion is on.
// ─────────────────────────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReduced(mq.matches)
    const handler = (event: MediaQueryListEvent) => setPrefersReduced(event.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    // Older Safari quirk — addListener / removeListener still works.
    mq.addListener(handler)
    return () => mq.removeListener(handler)
  }, [])
  return prefersReduced
}

function useAnimatedNumber(target: number, durationMs: number, snap: boolean): number {
  const [value, setValue] = useState(snap ? target : 0)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  const startValueRef = useRef<number>(0)

  useEffect(() => {
    if (snap || !Number.isFinite(target)) {
      setValue(target)
      return
    }
    startValueRef.current = value
    startRef.current = null
    const step = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp
      const elapsed = timestamp - startRef.current
      const t = Math.min(1, elapsed / durationMs)
      // Cubic ease-out.
      const eased = 1 - Math.pow(1 - t, 3)
      const next = startValueRef.current + (target - startValueRef.current) * eased
      setValue(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // value intentionally excluded from deps — we re-anchor each target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, snap])

  return value
}

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterMetric — large display cell in the four-cell strip.
// ─────────────────────────────────────────────────────────────────────────

function RecoveryCenterMetric({
  label,
  display,
  numericValue,
  severity,
  icon,
  rationale,
  onClick,
  testId,
}: {
  label: string
  display: string
  /** When defined, the value count-ups from 0; otherwise we render display verbatim. */
  numericValue: number | null
  severity: MetricSeverity
  icon: React.ReactNode
  rationale: string
  onClick: () => void
  testId: string
}) {
  const { t } = useT()
  const snap = usePrefersReducedMotion()
  const target = numericValue ?? 0
  const animated = useAnimatedNumber(target, 600, snap)
  const showAnimated = numericValue !== null && Number.isFinite(numericValue)
  const rendered = showAnimated ? formatAnimatedValue(animated, display) : display
  return (
    <button
      type="button"
      className="we-recovery-center-metric"
      data-severity={severity}
      onClick={onClick}
      aria-label={t('recoveryCenter.metric.aria', { label, display, rationale })}
      data-testid={testId}
    >
      <span className="we-recovery-center-metric__icon" aria-hidden="true">{icon}</span>
      <span className="we-recovery-center-metric__label">{label}</span>
      <span className="we-recovery-center-metric__value">{rendered}</span>
      <span className="we-recovery-center-metric__rationale">{rationale}</span>
    </button>
  )
}

/** Format the count-up value using the SAME suffix the API supplied in `display`.
 *  Keeps "12m" / "98%" / "$1.42" / "—" stable while letting the integer animate. */
function formatAnimatedValue(animated: number, display: string): string {
  // "—" is the absence sentinel; never animate.
  if (display === '—') return display
  const trailing = display.match(/[^\d.-].*$/)?.[0] ?? ''
  const leading = display.match(/^[^\d-]+/)?.[0] ?? ''
  const hasFraction = display.includes('.')
  const rounded = hasFraction ? animated.toFixed(1) : Math.round(animated).toString()
  return `${leading}${rounded}${trailing}`
}

// ─────────────────────────────────────────────────────────────────────────
// Recommended actions — pure helper + tile renderer.
// ─────────────────────────────────────────────────────────────────────────

export type RecommendedActionId =
  | 'resolve_approvals'
  | 'recover_cluster'
  | 'triage_failures'
  | 'review_workflow_risk'
  | 'run_getting_started'
  | 'healthy_try_studio'

export type RecommendedActionSeverity = 'cobalt' | 'cyan' | 'success' | 'warning' | 'danger'

export type RecommendedAction = {
  id: RecommendedActionId
  title: string
  body: string
  ctaLabel: string
  ctaTab: ActiveTab
  severity: RecommendedActionSeverity
}

export type RecommendedActionSignals = {
  openFailures: number
  pendingApprovals: number
  topClusterFrequency: number
  healthScore: number | null
  totalRuns: number
}

/**
 * Deterministic priority of recommended next actions. Operator-blocking
 * work first (approvals waiting on input), then bulk recovery, then
 * triage, then long-term risk, then onboarding. Pure function — easy
 * to unit-test each fixture in isolation.
 */
export function computeRecommendedActions(signals: RecommendedActionSignals): RecommendedAction[] {
  const actions: RecommendedAction[] = []
  if (signals.pendingApprovals > 0) {
    actions.push({
      id: 'resolve_approvals',
      title: runtimeT('recoveryCenter.action.resolve_approvals.title', { count: signals.pendingApprovals }),
      body: runtimeT('recoveryCenter.action.resolve_approvals.body'),
      ctaLabel: runtimeT('recoveryCenter.action.resolve_approvals.cta'),
      ctaTab: 'runs',
      severity: 'warning',
    })
  }
  if (signals.topClusterFrequency >= 2) {
    actions.push({
      id: 'recover_cluster',
      title: runtimeT('recoveryCenter.action.recover_cluster.title', { count: signals.topClusterFrequency }),
      body: runtimeT('recoveryCenter.action.recover_cluster.body'),
      ctaLabel: runtimeT('recoveryCenter.action.recover_cluster.cta'),
      ctaTab: 'operations',
      severity: 'cobalt',
    })
  }
  if (signals.openFailures > 0) {
    actions.push({
      id: 'triage_failures',
      title: runtimeT('recoveryCenter.action.triage_failures.title', { count: signals.openFailures }),
      body: runtimeT('recoveryCenter.action.triage_failures.body'),
      ctaLabel: runtimeT('recoveryCenter.action.triage_failures.cta'),
      ctaTab: 'runs',
      severity: 'warning',
    })
  }
  if (signals.healthScore !== null && signals.healthScore < 80) {
    const severity: RecommendedActionSeverity = signals.healthScore < 60 ? 'danger' : 'warning'
    actions.push({
      id: 'review_workflow_risk',
      title: runtimeT('recoveryCenter.action.review_workflow_risk.title'),
      body: runtimeT('recoveryCenter.action.review_workflow_risk.body'),
      ctaLabel: runtimeT('recoveryCenter.action.review_workflow_risk.cta'),
      ctaTab: 'operations',
      severity,
    })
  }
  if (signals.totalRuns < 5 && signals.openFailures === 0 && signals.pendingApprovals === 0) {
    actions.push({
      id: 'run_getting_started',
      title: runtimeT('recoveryCenter.action.run_getting_started.title'),
      body: runtimeT('recoveryCenter.action.run_getting_started.body'),
      ctaLabel: runtimeT('recoveryCenter.action.run_getting_started.cta'),
      ctaTab: 'copilot',
      severity: 'cyan',
    })
  }
  if (actions.length === 0) {
    actions.push({
      id: 'healthy_try_studio',
      title: runtimeT('recoveryCenter.action.healthy_try_studio.title'),
      body: runtimeT('recoveryCenter.action.healthy_try_studio.body'),
      ctaLabel: runtimeT('recoveryCenter.action.healthy_try_studio.cta'),
      ctaTab: 'copilot',
      severity: 'success',
    })
  }
  return actions
}

// ─────────────────────────────────────────────────────────────────────────
// Hero greeting — adapts to local time + recovery posture.
// ─────────────────────────────────────────────────────────────────────────

export function buildGreeting(args: {
  hour: number
  displayName: string | null
  openFailures: number
  pendingApprovals: number
  healthScore: number | null
  totalRuns: number
}): { salutation: string; subline: string } {
  // Greeting drops the "there" filler when no name is available — a bare
  // "Good morning." reads cleaner than "Good morning, there." and avoids
  // any sense of generic auto-personalization. Suffix variants land in
  // sibling keys so the i18n parity test holds for both shapes.
  const slot = args.hour < 12 ? 'morning' : args.hour < 18 ? 'afternoon' : 'evening'
  const slotKey = `recoveryCenter.greeting.${slot}${args.displayName ? '' : 'Bare'}`
  const salutation = args.displayName
    ? runtimeT(slotKey, { who: args.displayName })
    : runtimeT(slotKey)
  let subline: string
  if (args.totalRuns === 0) {
    // In an empty workspace the pitch line below the hero carries the
    // copy work — surface the dynamic recovery posture instead of a
    // generic welcome (which would duplicate the pitch).
    subline = runtimeT('recoveryCenter.greeting.subline.clean')
  } else if (args.pendingApprovals > 0) {
    subline = runtimeT('recoveryCenter.greeting.subline.approvals', { count: args.pendingApprovals })
  } else if (args.openFailures > 0) {
    subline = runtimeT('recoveryCenter.greeting.subline.failures', { count: args.openFailures })
  } else if (args.healthScore !== null && args.healthScore >= 80) {
    subline = runtimeT('recoveryCenter.greeting.subline.allClear', { score: args.healthScore })
  } else if (args.healthScore !== null) {
    subline = runtimeT('recoveryCenter.greeting.subline.stable', { score: args.healthScore })
  } else {
    subline = runtimeT('recoveryCenter.greeting.subline.clean')
  }
  return { salutation, subline }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function humanizeAge(iso: string | undefined, nowMs: number | null): string {
  if (nowMs === null) return ''
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((nowMs - then) / 1000))
  if (secs < 60) return runtimeT('recoveryCenter.relative.seconds', { count: secs })
  const mins = Math.floor(secs / 60)
  if (mins < 60) return runtimeT('recoveryCenter.relative.minutes', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 48) return runtimeT('recoveryCenter.relative.hours', { count: hours })
  const days = Math.floor(hours / 24)
  return runtimeT('recoveryCenter.relative.days', { count: days })
}

function readErrorSignature(errorJson: unknown): string {
  const fallback = runtimeT('recoveryCenter.errorSignatureFallback')
  if (!errorJson || typeof errorJson !== 'object') return fallback
  const candidate = (errorJson as { signature?: unknown; message?: unknown; error?: unknown })
  if (typeof candidate.signature === 'string') return candidate.signature
  if (typeof candidate.message === 'string') return candidate.message
  if (typeof candidate.error === 'string') return candidate.error
  return fallback
}

function readWorkflowName(dlq: DeadLetter, runs: RunSummary[]): string {
  const fromWorkflow = (dlq.workflowJson as { name?: unknown } | null | undefined)?.name
  if (typeof fromWorkflow === 'string' && fromWorkflow.length > 0) return fromWorkflow
  const run = runs.find((entry) => entry.id === dlq.runId)
  if (run?.workflowVersionId) return run.workflowVersionId
  return runtimeT('recoveryCenter.adHocWorkflow')
}

function clusterCategoryLabel(category: ClusterCategory): string {
  return runtimeT(`recoveryCenter.cluster.category.${category}`)
}

function clusterOwnerLabel(owner: ClusterOwner): string {
  return runtimeT(`recoveryCenter.cluster.owner.${owner}`)
}

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterPanel — the main composer.
// ─────────────────────────────────────────────────────────────────────────

export function RecoveryCenterPanel(props: RecoveryCenterPanelProps) {
  const { t, i18n } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const user = useWorkflowStore((state) => state.user)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [clusters, setClusters] = useState<ClustersResponse | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const [currentHour, setCurrentHour] = useState(12)
  const [nowMs, setNowMs] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setMetricsLoading(true)
    setMetricsError(null)
    api('/recovery/metrics')
      .then((payload) => {
        if (cancelled) return
        setMetrics(payload as RecoveryMetrics)
        setMetricsLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setMetricsError(err instanceof Error ? err.message : runtimeT('recoveryCenter.empty.metricsUnavailableFallback'))
        setMetricsLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, i18n.language])

  useEffect(() => {
    let cancelled = false
    api('/dlq/clusters')
      .then((payload) => {
        if (cancelled) return
        setClusters(payload as ClustersResponse)
      })
      .catch(() => {
        if (cancelled) return
        setClusters(null)
      })
    return () => { cancelled = true }
  }, [platformVersion])

  const openDeadLetters = useMemo(
    () => props.deadLetters.filter((dlq) => dlq.status === 'open'),
    [props.deadLetters],
  )

  useEffect(() => {
    setCurrentHour(new Date().getHours())
  }, [])

  useEffect(() => {
    setNowMs(Date.now())
  }, [platformVersion, openDeadLetters.length])

  const waitingNodes = useMemo(
    () => props.runNodes.filter((node) => node.status === 'waiting'),
    [props.runNodes],
  )
  const topClusters = useMemo(
    () => (clusters?.clusters ?? []).slice().sort((a, b) => b.frequency - a.frequency).slice(0, 3),
    [clusters],
  )
  const topClusterFrequency = topClusters[0]?.frequency ?? 0

  const totalRuns = props.runs.length
  const healthScore = readHealthScore(metrics)
  // `buildGreeting` and `computeRecommendedActions` call `runtimeT(...)`
  // internally, so the memo MUST re-compute when the active locale changes;
  // adding `i18n.language` to the dep array is the cheapest fix that keeps
  // the helper functions pure (vs. plumbing `t` through every call site).
  const greeting = useMemo(() => buildGreeting({
    hour: currentHour,
    displayName: readDisplayName(user),
    openFailures: openDeadLetters.length,
    pendingApprovals: waitingNodes.length,
    healthScore,
    totalRuns,
  }), [currentHour, user, openDeadLetters.length, waitingNodes.length, healthScore, totalRuns, i18n.language])

  const recommendedActions = useMemo(() => computeRecommendedActions({
    openFailures: openDeadLetters.length,
    pendingApprovals: waitingNodes.length,
    topClusterFrequency,
    healthScore,
    totalRuns,
  }), [openDeadLetters.length, waitingNodes.length, topClusterFrequency, healthScore, totalRuns, i18n.language])

  const isEmpty = openDeadLetters.length === 0
    && waitingNodes.length === 0
    && (clusters?.clusters.length ?? 0) === 0
    && totalRuns === 0

  const metricStrip = (
    <section className="we-recovery-center-strip" aria-label={t('recoveryCenter.metricStripAria')}>
      <RecoveryCenterMetric
        label={t('recoveryCenter.metric.failures.label')}
        display={openDeadLetters.length === 0 ? '0' : String(openDeadLetters.length)}
        numericValue={openDeadLetters.length}
        severity={openDeadLetters.length === 0 ? 'healthy' : openDeadLetters.length > 5 ? 'unhealthy' : 'warn'}
        icon={<AlertTriangle size={16} aria-hidden="true" />}
        rationale={openDeadLetters.length === 0 ? t('recoveryCenter.metric.failures.rationaleEmpty') : t('recoveryCenter.metric.failures.rationale')}
        onClick={() => props.onOpenTab('runs')}
        testId="recovery-center-metric-failures"
      />
      <RecoveryCenterMetric
        label={t('recoveryCenter.metric.mttr.label')}
        display={metrics?.mttr.display ?? '—'}
        numericValue={metrics?.mttr.value ?? null}
        severity={metrics?.mttr.severity ?? 'neutral'}
        icon={<RefreshCw size={16} aria-hidden="true" />}
        rationale={metrics?.mttr ? tRecoveryMetricRationale(metrics.mttr) : t('recoveryCenter.metric.mttr.rationaleFallback')}
        onClick={() => props.onOpenTab('operations')}
        testId="recovery-center-metric-mttr"
      />
      <RecoveryCenterMetric
        label={t('recoveryCenter.metric.approvals.label')}
        display={waitingNodes.length === 0 ? '0' : String(waitingNodes.length)}
        numericValue={waitingNodes.length}
        severity={waitingNodes.length === 0 ? 'healthy' : 'warn'}
        icon={<Users size={16} aria-hidden="true" />}
        rationale={waitingNodes.length === 0 ? t('recoveryCenter.metric.approvals.rationaleEmpty') : t('recoveryCenter.metric.approvals.rationale')}
        onClick={() => props.onOpenTab('runs')}
        testId="recovery-center-metric-approvals"
      />
      <RecoveryCenterMetric
        label={t('recoveryCenter.metric.replay.label')}
        display={metrics?.replayRate.display ?? '—'}
        numericValue={metrics?.replayRate.value ?? null}
        severity={metrics?.replayRate.severity ?? 'neutral'}
        icon={<Zap size={16} aria-hidden="true" />}
        rationale={metrics?.replayRate ? tRecoveryMetricRationale(metrics.replayRate) : t('recoveryCenter.metric.replay.rationaleFallback')}
        onClick={() => props.onOpenTab('operations')}
        testId="recovery-center-metric-replay"
      />
    </section>
  )

  // Operator chat surface (left, 1.7fr) + live status rail (right, 1fr).
  // Mirrors `ui_kits/studio/home-operator.html` from the design system zip.
  // The layout is the same in empty and populated states — every tile
  // surfaces its own AllClearState when it has nothing to show, so the
  // operator's mental model never changes between "fresh install" and
  // "production workflow".
  return (
    <div className="we-recovery-center-panel we-recovery-center-panel--operator">
      <header className="we-recovery-center-hero" role="banner">
        <div className="we-recovery-center-hero__copy">
          <div className="section-kicker">{t('recoveryCenter.kicker')}</div>
          <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">{greeting.salutation}</h1>
          <p className="we-recovery-center-hero__subline">{greeting.subline}</p>
          <p className="we-recovery-center-hero__pitch">{t('recoveryCenter.hero.pitch')}</p>
        </div>
        <HealthRing score={healthScore} />
      </header>

      {metricStrip}

      <div className="we-operator-grid">
        <section className="we-operator-chat">
          <RecoveryCenterComposer
            onOpenTab={props.onOpenTab}
            recentDlqRunId={openDeadLetters[0]?.runId}
            showSeedTranscript={isEmpty}
          />
          {isEmpty && (
            <RecoveryFlowDemo
              onOpenStudio={() => props.onOpenTab('copilot')}
              onOpenRecipes={() => props.onOpenTab('templates')}
            />
          )}
          <RecommendedActionsTile actions={recommendedActions} onOpenTab={props.onOpenTab} />
          <RecoveryQueueTile
            deadLetters={openDeadLetters}
            runs={props.runs}
            nowMs={nowMs}
            onOpenRun={props.onOpenRun}
            onOpenTab={props.onOpenTab}
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
          <OperatorTodayTile
            metrics={metrics}
            openDeadLetters={openDeadLetters.length}
            waitingNodes={waitingNodes.length}
            onOpenTab={props.onOpenTab}
          />
          <BudgetTile onOpenTab={props.onOpenTab} />
        </aside>
      </div>

      {metricsError && !metricsLoading && (
        <p className="we-recovery-center-error" role="status">
          {t('recoveryCenter.metricsUnavailable', { detail: metricsError })}
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OperatorTodayTile — mini stats grid mirroring the right rail of
// `ui_kits/studio/home-operator.html` (Runs / Success / Spend / MTTR).
// Lives only here; not a generic export.
// ─────────────────────────────────────────────────────────────────────────

function OperatorTodayTile({
  metrics,
  openDeadLetters,
  waitingNodes,
  onOpenTab,
}: {
  metrics: RecoveryMetrics | null
  openDeadLetters: number
  waitingNodes: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.today.title')}
      kicker={t('recoveryCenter.tile.today.kicker')}
      severity="cobalt"
      icon={<BarChart3 size={18} aria-hidden="true" />}
      testId="recovery-center-tile-today"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
        >
          {t('recoveryCenter.tile.today.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      <div className="we-operator-mini">
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.runs')}</div>
          <div className="we-operator-mini__val">{metrics?.terminalRuns ?? 0}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.windowDays', { days: metrics?.windowDays ?? 30 })}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.success')}</div>
          <div className="we-operator-mini__val">{metrics?.successRate.display ?? '—'}</div>
          <div className="we-operator-mini__delta" data-severity={metrics?.successRate.severity ?? 'neutral'}>{metrics?.successRate.severity ?? '—'}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.failures')}</div>
          <div className="we-operator-mini__val">{openDeadLetters}</div>
          <div className="we-operator-mini__delta" data-severity={openDeadLetters === 0 ? 'success' : 'danger'}>{openDeadLetters === 0 ? t('recoveryCenter.tile.today.clean') : t('recoveryCenter.tile.today.pending')}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.mttr')}</div>
          <div className="we-operator-mini__val">{metrics?.mttr.display ?? '—'}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.pending')} {waitingNodes}</div>
        </div>
      </div>
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AllClearState — shared "everything is OK" empty-state component.
// Stylized with a soft success ring + check glyph + reassuring copy.
// Used inside each tile when there's no work for the operator.
// ─────────────────────────────────────────────────────────────────────────

function AllClearState({ message, testId }: { message: string; testId?: string }) {
  const { t } = useT()
  return (
    <div className="we-recovery-allclear" data-testid={testId}>
      <span className="we-recovery-allclear__ring" aria-hidden="true">
        <CircleCheck size={18} />
      </span>
      <div className="we-recovery-allclear__copy">
        <strong>{t('recoveryCenter.allClear.title')}</strong>
        <span>{message}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Operator composer — chat-style input + quick chips that route to existing
// tabs (Runs / Inspector / Operations / Copilot). The composer is v1
// UI-only: pressing Send dispatches a "coming soon" toast and opens the
// AI Studio tab. The chips route directly so the operator can jump into
// the relevant surface in one click.
// ─────────────────────────────────────────────────────────────────────────

function RecoveryCenterComposer({
  onOpenTab,
  recentDlqRunId,
  showSeedTranscript,
}: {
  onOpenTab: (tab: ActiveTab) => void
  recentDlqRunId?: string
  showSeedTranscript?: boolean
}) {
  const { t } = useT()
  const addToast = useWorkflowStore((state) => state.addToast)
  const nodes = useWorkflowStore((state) => state.nodes)
  const edges = useWorkflowStore((state) => state.edges)
  const currentWorkflowName = useWorkflowStore((state) => state.currentWorkflowName)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ text: string; mode: 'ai' | 'fallback'; aiError?: string } | null>(null)

  const buildWorkflowPayload = () => {
    return {
      id: currentWorkflowId,
      name: currentWorkflowName,
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.type, config: node.data.config ?? {}, position: node.position })),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, data: edge.data })),
    }
  }

  const askWorkflow = async (prompt: string) => {
    if (nodes.length === 0) {
      addToast(runtimeT('recoveryCenter.composer.needWorkflow'), 'info')
      onOpenTab('copilot')
      return
    }
    setBusy(true)
    setAnswer(null)
    try {
      const result = await api('/ai/explain-workflow', {
        method: 'POST',
        body: JSON.stringify({ workflow: buildWorkflowPayload(), prompt }),
      }) as { mode?: 'ai' | 'fallback' | 'error'; explanation?: string; aiError?: string; error?: string }
      if (result.error) {
        addToast(result.error, 'error')
        return
      }
      const mode: 'ai' | 'fallback' = result.mode === 'ai' ? 'ai' : 'fallback'
      setAnswer({
        text: result.explanation ?? runtimeT('recoveryCenter.composer.noAnswer'),
        mode,
        aiError: result.aiError,
      })
    } catch (error) {
      addToast(error instanceof Error ? error.message : runtimeT('recoveryCenter.composer.callFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const askRun = async (runId: string, question: string) => {
    setBusy(true)
    setAnswer(null)
    try {
      const result = await api('/ai/explain-run', {
        method: 'POST',
        body: JSON.stringify({ runId, question }),
      }) as { mode?: 'ai' | 'fallback' | 'error'; explanation?: string; aiError?: string; error?: string }
      if (result.error) {
        addToast(result.error, 'error')
        return
      }
      const mode: 'ai' | 'fallback' = result.mode === 'ai' ? 'ai' : 'fallback'
      setAnswer({
        text: result.explanation ?? runtimeT('recoveryCenter.composer.noAnswer'),
        mode,
        aiError: result.aiError,
      })
    } catch (error) {
      addToast(error instanceof Error ? error.message : runtimeT('recoveryCenter.composer.callFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const prompt = value.trim()
    if (!prompt) return
    await askWorkflow(prompt)
    setValue('')
  }

  const handleWhyFail = () => {
    if (recentDlqRunId) {
      void askRun(recentDlqRunId, runtimeT('recoveryCenter.composer.chip.whyFail'))
    } else {
      onOpenTab('runs')
    }
  }

  const handleWhatChanged = () => {
    if (nodes.length === 0) {
      onOpenTab('inspector')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.whatChangedPrompt'))
  }

  const handleSuggestFix = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.suggestFixPrompt'))
  }

  const handleSummarize = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.summarizePrompt'))
  }

  const handleSpend = () => {
    if (nodes.length === 0) {
      onOpenTab('operations')
      return
    }
    void askWorkflow(runtimeT('recoveryCenter.composer.intent.spendPrompt'))
  }

  return (
    <section className="recovery-center-composer" data-testid="recovery-center-composer">
      <header className="recovery-center-composer__head">
        <span className="recovery-center-composer__avatar" aria-hidden="true">
          <Sparkles size={14} />
        </span>
        <div>
          <div className="section-kicker">{t('recoveryCenter.composer.kicker')}</div>
        </div>
      </header>

      {showSeedTranscript && !answer && (
        <div className="recovery-center-composer__seed" data-testid="recovery-center-composer-seed">
          <article className="recovery-center-composer__msg recovery-center-composer__msg--ai">
            <span className="recovery-center-composer__msg-ic" aria-hidden="true"><Sparkles size={12} /></span>
            <div className="recovery-center-composer__msg-body">
              <header>
                <strong>{t('recoveryCenter.composer.seed.ai1.who')}</strong>
                <small>{t('recoveryCenter.composer.seed.ai1.when')}</small>
              </header>
              <p>{t('recoveryCenter.composer.seed.ai1.body')}</p>
              <div className="recovery-center-composer__seed-chips">
                <span className="recovery-center-composer__seed-chip"><Sparkles size={10} aria-hidden="true" /> secret_missing</span>
                <span className="recovery-center-composer__seed-chip"><Layers size={10} aria-hidden="true" /> 9 cluster entries</span>
                <span className="recovery-center-composer__seed-chip"><Check size={10} aria-hidden="true" /> sandbox 412ms</span>
                <span className="recovery-center-composer__seed-chip recovery-center-composer__seed-chip--conf">92 AI</span>
              </div>
              <div className="recovery-center-composer__seed-actions" aria-label={t('recoveryCenter.composer.seed.ai1.actionsAria')}>
                <button type="button" className="command-button command-button-primary command-button-compact" disabled>
                  <Check size={13} aria-hidden="true" />
                  <span>{t('recoveryCenter.composer.seed.ai1.action.apply')}</span>
                </button>
                <button type="button" className="command-button command-button-compact" disabled>
                  <FileDiff size={13} aria-hidden="true" />
                  <span>{t('recoveryCenter.composer.seed.ai1.action.diff')}</span>
                </button>
                <button type="button" className="command-button command-button-compact" disabled>
                  <span>{t('recoveryCenter.composer.seed.ai1.action.reject')}</span>
                </button>
              </div>
            </div>
          </article>

          <article className="recovery-center-composer__msg recovery-center-composer__msg--user">
            <span className="recovery-center-composer__msg-ic" aria-hidden="true"><User size={12} /></span>
            <div className="recovery-center-composer__msg-body">
              <header>
                <strong>{t('recoveryCenter.composer.seed.user.who')}</strong>
                <small>{t('recoveryCenter.composer.seed.user.when')}</small>
              </header>
              <p>{t('recoveryCenter.composer.seed.user.body')}</p>
            </div>
          </article>

          <article className="recovery-center-composer__msg recovery-center-composer__msg--ai">
            <span className="recovery-center-composer__msg-ic" aria-hidden="true"><Sparkles size={12} /></span>
            <div className="recovery-center-composer__msg-body">
              <header>
                <strong>{t('recoveryCenter.composer.seed.ai2.who')}</strong>
                <small>{t('recoveryCenter.composer.seed.ai2.when')}</small>
              </header>
              <p>{t('recoveryCenter.composer.seed.ai2.body')}</p>
            </div>
          </article>

          <div className="recovery-center-composer__seed-hint">
            <Sparkles size={11} aria-hidden="true" />
            <span>{t('recoveryCenter.composer.seed.hint')}</span>
          </div>
        </div>
      )}

      <form className="recovery-center-composer__input" onSubmit={submit}>
        <Sparkles size={16} aria-hidden="true" />
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('recoveryCenter.composer.placeholder')}
          aria-label={t('recoveryCenter.composer.placeholder')}
          disabled={busy}
        />
        <button type="submit" className="recovery-center-composer__send" disabled={busy || value.trim().length === 0}>
          <ArrowUp size={13} aria-hidden="true" />
          <span>{busy ? t('recoveryCenter.composer.thinking') : t('recoveryCenter.composer.send')}</span>
        </button>
      </form>
      {answer && (
        <div className={`recovery-center-composer__answer recovery-center-composer__answer--${answer.mode}`} data-testid="recovery-center-composer-answer">
          <span className={`recovery-center-composer__answer-pill recovery-center-composer__answer-pill--${answer.mode}`}>{answer.mode === 'ai' ? t('recoveryCenter.composer.modeAi') : t('recoveryCenter.composer.modeFallback')}</span>
          <p>{answer.text}</p>
          {answer.aiError && <small className="recovery-center-composer__answer-error">{answer.aiError}</small>}
          <div className="recovery-center-composer__answer-acts">
            <button type="button" className="command-button command-button-compact" onClick={() => setAnswer(null)}>
              {t('recoveryCenter.composer.dismiss')}
            </button>
            <button type="button" className="command-button command-button-compact" onClick={() => onOpenTab('copilot')}>
              {t('recoveryCenter.composer.openStudio')}
            </button>
          </div>
        </div>
      )}
      {/* Chips ordered recovery-first: Suggest fix and Why fail (the two
          chips that touch Janusly's differentiator) come before the
          diagnostic + diff + spend chips. */}
      <div className="recovery-center-composer__chips">
        <button type="button" className="recovery-center-composer__chip recovery-center-composer__chip--primary" onClick={handleSuggestFix} disabled={busy}>
          <Wand2 size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.suggestFix')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleWhyFail} disabled={busy}>
          <ShieldAlert size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.whyFail')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleWhatChanged} disabled={busy}>
          <FileDiff size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.whatChanged')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleSummarize} disabled={busy}>
          <BarChart3 size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.summarize')}</span>
        </button>
        <button type="button" className="recovery-center-composer__chip" onClick={handleSpend} disabled={busy}>
          <DollarSign size={11} aria-hidden="true" />
          <span>{t('recoveryCenter.composer.chip.spend')}</span>
        </button>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Tile sub-components
// ─────────────────────────────────────────────────────────────────────────

function RecoveryCenterTile({
  title,
  kicker,
  severity,
  icon,
  footer,
  children,
  testId,
}: {
  title: string
  kicker: string
  severity?: RecommendedActionSeverity | 'neutral'
  icon: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  testId: string
}) {
  return (
    <section
      className="we-recovery-center-tile"
      data-severity={severity ?? 'neutral'}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <header className="we-recovery-center-tile__head">
        <span className="we-recovery-center-tile__icon" aria-hidden="true">{icon}</span>
        <div className="we-recovery-center-tile__heading">
          <div className="section-kicker">{kicker}</div>
          <h2 id={`${testId}-title`}>{title}</h2>
        </div>
      </header>
      <div className="we-recovery-center-tile__body">
        {children}
      </div>
      {footer && <footer className="we-recovery-center-tile__footer">{footer}</footer>}
    </section>
  )
}

function RecoveryQueueTile({
  deadLetters,
  runs,
  nowMs,
  onOpenRun,
  onOpenTab,
}: {
  deadLetters: DeadLetter[]
  runs: RunSummary[]
  nowMs: number | null
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const top = deadLetters.slice(0, 3)
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.queue.title')}
      kicker={t('recoveryCenter.tile.queue.kicker')}
      severity={deadLetters.length === 0 ? 'success' : 'warning'}
      icon={<Inbox size={18} aria-hidden="true" />}
      testId="recovery-center-tile-queue"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('runs')}
          data-testid="recovery-center-queue-open-all"
        >
          {t('recoveryCenter.tile.queue.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.queue.empty')}
          testId="recovery-center-queue-allclear"
        />
      ) : (
        <ul className="we-recovery-center-rows">
          {top.map((dlq) => {
            const workflowName = readWorkflowName(dlq, runs)
            const signature = readErrorSignature(dlq.errorJson)
            const age = humanizeAge(dlq.createdAt, nowMs)
            return (
              <li key={dlq.id}>
                <button
                  type="button"
                  className="we-recovery-center-row"
                  onClick={() => {
                    void onOpenRun(dlq.runId)
                    onOpenTab('runs')
                  }}
                  data-testid={`recovery-center-queue-row-${dlq.id}`}
                >
                  <span className="we-recovery-center-row__title">{workflowName}</span>
                  <span className="we-recovery-center-row__meta">
                    <code className="we-recovery-center-row__node">{dlq.nodeId}</code>
                    <span className="we-recovery-center-row__pill" data-severity="warning">{signature}</span>
                  </span>
                  <span className="we-recovery-center-row__age">{age}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

function FailureClustersTile({
  clusters,
  totalSamples,
  onOpenTab,
}: {
  clusters: FailureCluster[]
  totalSamples: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.clusters.title')}
      kicker={t('recoveryCenter.tile.clusters.kicker', { count: totalSamples })}
      severity={clusters.length === 0 ? 'success' : 'cobalt'}
      icon={<Eye size={18} aria-hidden="true" />}
      testId="recovery-center-tile-clusters"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
          data-testid="recovery-center-clusters-open-all"
        >
          {t('recoveryCenter.tile.clusters.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {clusters.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.clusters.empty')}
          testId="recovery-center-clusters-allclear"
        />
      ) : (
        <ul className="we-recovery-watch">
          {clusters.map((cluster) => {
            const state = cluster.frequency >= 2 ? 'ready' : 'monitoring'
            const stateLabel = state === 'ready'
              ? t('recoveryCenter.tile.clusters.statePatchReady')
              : t('recoveryCenter.tile.clusters.stateMonitoring')
            return (
              <li key={cluster.signature}>
                <div className="we-recovery-watch-row" data-testid={`recovery-center-watch-row-${cluster.signature}`}>
                  <span className="we-recovery-watch-row__sig">{cluster.signature}</span>
                  <div className="we-recovery-watch-row__body">
                    <strong>{clusterCategoryLabel(cluster.category)}</strong>
                    <small>{t('recoveryCenter.tile.clusters.frequency', { count: cluster.frequency })} · {clusterOwnerLabel(cluster.suggestedOwner)}</small>
                  </div>
                  <span className={`we-recovery-watch-row__state we-recovery-watch-row__state--${state}`}>{stateLabel}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

function PendingApprovalsTile({
  waitingNodes,
  runs,
  onOpenRun,
  onOpenTab,
  onApproveNode,
}: {
  waitingNodes: RunNode[]
  runs: RunSummary[]
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
  onApproveNode: (nodeId: string) => void | Promise<void>
}) {
  const { t } = useT()
  const top = waitingNodes.slice(0, 3)
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.approvals.title')}
      kicker={t('recoveryCenter.tile.approvals.kicker')}
      severity={waitingNodes.length === 0 ? 'success' : 'warning'}
      icon={<CheckSquare size={18} aria-hidden="true" />}
      testId="recovery-center-tile-approvals"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('runs')}
          data-testid="recovery-center-approvals-open-all"
        >
          {t('recoveryCenter.tile.approvals.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.approvals.empty')}
          testId="recovery-center-approvals-allclear"
        />
      ) : (
        <ul className="we-recovery-signoff">
          {top.map((node) => {
            const waiting = (node.stateJson as { waiting?: { kind?: string; title?: string } } | undefined)?.waiting
            const kind = waiting?.kind ?? 'approval'
            const title = waiting?.title
              ?? (kind === 'human_form' ? t('recoveryCenter.tile.approvals.formTitle') : t('recoveryCenter.tile.approvals.approvalTitle'))
            const matchingRun = runs.find((entry) => entry.workflowVersionId && entry.status === 'paused')
            const runId = matchingRun?.id
            return (
              <li key={node.nodeId} className="we-recovery-signoff-row" data-testid={`recovery-center-approvals-row-${node.nodeId}`}>
                <span className="we-recovery-signoff-row__ic" aria-hidden="true">
                  <ShieldAlert size={14} />
                </span>
                <div className="we-recovery-signoff-row__body">
                  <strong>{title}</strong>
                  <p>
                    <code>{node.nodeId}</code>
                    <span> · {kind === 'human_form' ? t('recoveryCenter.tile.approvals.kindForm') : t('recoveryCenter.tile.approvals.kindApproval')} · {t('recoveryCenter.tile.approvals.waiting')}</span>
                  </p>
                  <div className="we-recovery-signoff-row__acts">
                    {kind === 'approval' && (
                      <button
                        type="button"
                        className="command-button command-button-primary command-button-compact"
                        onClick={() => onApproveNode(node.nodeId)}
                      >
                        <Check size={14} aria-hidden="true" />
                        <span>{t('recoveryCenter.tile.approvals.apply')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="command-button command-button-compact"
                      onClick={() => {
                        if (runId) void onOpenRun(runId)
                        onOpenTab('runs')
                      }}
                    >
                      {t('recoveryCenter.tile.approvals.hold')}
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

function RecommendedActionsTile({
  actions,
  onOpenTab,
}: {
  actions: RecommendedAction[]
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const iconByAction: Record<RecommendedActionId, React.ReactNode> = {
    resolve_approvals: <Users size={16} aria-hidden="true" />,
    recover_cluster: <Layers size={16} aria-hidden="true" />,
    triage_failures: <AlertTriangle size={16} aria-hidden="true" />,
    review_workflow_risk: <Gauge size={16} aria-hidden="true" />,
    run_getting_started: <PlayCircle size={16} aria-hidden="true" />,
    healthy_try_studio: <Sparkles size={16} aria-hidden="true" />,
  }
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.actions.title')}
      kicker={t('recoveryCenter.tile.actions.kicker')}
      severity={actions[0]?.severity ?? 'cobalt'}
      icon={<Compass size={18} aria-hidden="true" />}
      testId="recovery-center-tile-actions"
    >
      <ol className="we-recovery-center-actions">
        {actions.map((action) => (
          <li key={action.id} data-severity={action.severity} data-testid={`recovery-center-action-${action.id}`}>
            <span className="we-recovery-center-actions__icon" aria-hidden="true">
              {iconByAction[action.id]}
            </span>
            <div className="we-recovery-center-actions__copy">
              <strong>{action.title}</strong>
              <small>{action.body}</small>
            </div>
            <button
              type="button"
              className="command-button command-button-primary"
              onClick={() => onOpenTab(action.ctaTab)}
              data-testid={`recovery-center-action-cta-${action.id}`}
            >
              {action.ctaLabel}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </RecoveryCenterTile>
  )
}

type BudgetEnvelope = {
  allowed?: boolean
  monthlyUsdSpent?: number
  monthlyUsdLimit?: number | null
  policy?: 'warn' | 'block'
  warningPercent?: number
  warningThresholdCrossed?: boolean
  exceededAt?: 'org' | 'workflow' | null
  resolvedScope?: 'org' | 'workflow' | null
}

function budgetBand(envelope: BudgetEnvelope | null): 'cobalt' | 'cyan' | 'success' | 'warning' | 'danger' {
  if (!envelope || envelope.monthlyUsdLimit == null || envelope.monthlyUsdLimit === 0) return 'cyan'
  const ratio = (envelope.monthlyUsdSpent ?? 0) / envelope.monthlyUsdLimit
  if (ratio >= 1) return 'danger'
  if (ratio >= (envelope.warningPercent ?? 80) / 100) return 'warning'
  return 'cobalt'
}

function BudgetTile({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [envelope, setEnvelope] = useState<BudgetEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/billing/budget')
      .then((payload) => {
        if (cancelled) return
        setEnvelope(payload as BudgetEnvelope)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('recoveryCenter.budget.unavailableFallback'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  const band = budgetBand(envelope)
  const tileSeverity: 'cobalt' | 'cyan' | 'success' | 'warning' | 'danger' = band === 'danger' ? 'danger' : band === 'warning' ? 'warning' : band === 'success' ? 'success' : band === 'cyan' ? 'cyan' : 'cobalt'
  const limit = envelope?.monthlyUsdLimit ?? null
  const spent = envelope?.monthlyUsdSpent ?? 0
  const hasBudget = limit !== null && limit > 0
  const ratio = hasBudget ? Math.min(1, spent / (limit ?? 1)) : 0
  const formatMoney = (value: number) => value.toFixed(2)

  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.budget.title')}
      kicker={hasBudget ? t('recoveryCenter.budget.kickerUsed', { percent: (ratio * 100).toFixed(0) }) : t('recoveryCenter.budget.kickerNotConfigured')}
      severity={tileSeverity}
      icon={<Coins size={18} aria-hidden="true" />}
      testId="recovery-center-tile-budget"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
          data-testid="recovery-center-budget-open-settings"
        >
          {hasBudget ? t('recoveryCenter.budget.openSettings') : t('recoveryCenter.budget.setBudget')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {loading && <p className="we-recovery-center-tile__empty">{t('recoveryCenter.budget.loading')}</p>}
      {error && (
        <p className="we-recovery-center-tile__empty" role="status">{t('recoveryCenter.budget.unavailable', { detail: error })}</p>
      )}
      {!loading && !error && !hasBudget && (
        <p className="we-recovery-center-tile__empty">
          {t('recoveryCenter.budget.notConfiguredBody')}
        </p>
      )}
      {!loading && !error && hasBudget && (
        <div className="we-recovery-center-budget" data-testid="recovery-center-budget-bar" data-band={band}>
          <div className="we-recovery-center-budget__row">
            <span className="we-recovery-center-budget__label">{t('recoveryCenter.budget.mtdLabel')}</span>
            <span className="we-recovery-center-budget__value">{t('recoveryCenter.budget.mtdValue', { spent: formatMoney(spent), limit: formatMoney(limit ?? 0) })}</span>
          </div>
          <div className="we-recovery-center-budget__bar" role="presentation" aria-hidden="true">
            <span className="we-recovery-center-budget__bar-rail" />
            <span
              className={`we-recovery-center-budget__bar-fill we-recovery-center-budget__bar-fill--${band}`}
              style={{ width: `${Math.max(2, ratio * 100)}%` }}
            />
          </div>
          <div className="we-recovery-center-budget__meta">
            <span>{t('recoveryCenter.budget.policyLabel')} <code>{envelope?.policy ?? 'warn'}</code></span>
            {envelope?.warningThresholdCrossed && (
              <span className="we-recovery-center-budget__pill" data-severity={band}>{t('recoveryCenter.budget.overWarning')}</span>
            )}
          </div>
        </div>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RecoveryFlowDemo — the headline visual of the Home when there's no real
// activity yet. Showcases Janusly's differentiator (the recovery loop)
// as a 4-step horizontal flow: failure → 3 AI suggestions w/ confidence →
// sandbox replay → apply across the failure cluster, with rollback hint.
//
// Replaces the legacy "Welcome to Janusly" hero card. Static markup
// (no animation) — the goal is to TEACH the loop, not to delight.
// Tokens-only colors; honors `prefers-reduced-motion` for hover.
// ─────────────────────────────────────────────────────────────────────────

function RecoveryFlowDemo({ onOpenStudio, onOpenRecipes }: { onOpenStudio: () => void; onOpenRecipes: () => void }) {
  const { t } = useT()
  return (
    <section className="we-flow-demo" aria-labelledby="we-flow-demo-title" data-testid="recovery-flow-demo">
      <header className="we-flow-demo__head">
        <div>
          <div className="section-kicker">{t('recoveryCenter.flowDemo.kicker')}</div>
          <h2 id="we-flow-demo-title">{t('recoveryCenter.flowDemo.title')}</h2>
          <p>{t('recoveryCenter.flowDemo.body')}</p>
        </div>
        <div className="we-flow-demo__ctas">
          <button
            type="button"
            className="command-button command-button-primary"
            onClick={onOpenStudio}
            data-testid="recovery-center-empty-cta-studio"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.cta.studio')}</span>
          </button>
          <button
            type="button"
            className="command-button"
            onClick={onOpenRecipes}
            data-testid="recovery-center-empty-cta-recipes"
          >
            <Workflow size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.cta.recipes')}</span>
          </button>
        </div>
      </header>

      <ol className="we-flow-demo__steps">
        <li className="we-flow-demo__step" data-step="failure" data-testid="recovery-flow-demo-step-1">
          <span className="we-flow-demo__step-num">1</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><AlertOctagon size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step1.title')}</strong>
          <code className="we-flow-demo__sig">0x9af2</code>
          <span className="we-flow-demo__step-meta">stripe.charge · secret_missing</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="suggest" data-testid="recovery-flow-demo-step-2">
          <span className="we-flow-demo__step-num">2</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><Wand2 size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step2.title')}</strong>
          <span className="we-flow-demo__confidence-strip">
            <span className="we-flow-demo__conf we-flow-demo__conf--top">92 AI</span>
            <span className="we-flow-demo__conf">78 AI</span>
            <span className="we-flow-demo__conf we-flow-demo__conf--low">55 AI</span>
          </span>
          <span className="we-flow-demo__step-meta">{t('recoveryCenter.flowDemo.step2.meta')}</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="sandbox" data-testid="recovery-flow-demo-step-3">
          <span className="we-flow-demo__step-num">3</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><FlaskConical size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step3.title')}</strong>
          <span className="we-flow-demo__pill we-flow-demo__pill--success">
            <Check size={11} aria-hidden="true" />
            <span>412ms · signature stable</span>
          </span>
          <span className="we-flow-demo__step-meta">{t('recoveryCenter.flowDemo.step3.meta')}</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="apply" data-testid="recovery-flow-demo-step-4">
          <span className="we-flow-demo__step-num">4</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><ShieldCheck size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step4.title')}</strong>
          <span className="we-flow-demo__pill we-flow-demo__pill--cobalt">
            <Layers size={11} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.step4.cluster', { count: 9 })}</span>
          </span>
          <span className="we-flow-demo__step-meta">
            <RotateCcw size={11} aria-hidden="true" />
            {t('recoveryCenter.flowDemo.step4.meta')}
          </span>
        </li>
      </ol>
    </section>
  )
}

function RecoveryCenterEmptyHero({
  onOpenStudio,
  onOpenRecipes,
}: {
  onOpenStudio: () => void
  onOpenRecipes: () => void
}) {
  const { t } = useT()
  return (
    <section className="we-recovery-center-empty" aria-labelledby="recovery-center-empty-title" data-testid="recovery-center-empty">
      <div className="we-recovery-center-empty__brand" aria-hidden="true">
        <BrandMark size={56} />
      </div>
      <div className="we-recovery-center-empty__copy">
        <div className="section-kicker">{t('recoveryCenter.empty.kicker')}</div>
        <h2 id="recovery-center-empty-title">{t('recoveryCenter.empty.title')}</h2>
        <p>{t('recoveryCenter.empty.body')}</p>
      </div>
      <div className="we-recovery-center-empty__ctas">
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={onOpenStudio}
          data-testid="recovery-center-empty-cta-studio"
        >
          <Sparkles size={16} aria-hidden="true" />
          {t('recoveryCenter.empty.openStudio')}
        </button>
        <button
          type="button"
          className="command-button"
          onClick={onOpenRecipes}
          data-testid="recovery-center-empty-cta-recipes"
        >
          <Workflow size={16} aria-hidden="true" />
          {t('recoveryCenter.empty.browseRecipes')}
        </button>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Misc readers
// ─────────────────────────────────────────────────────────────────────────

function readHealthScore(metrics: RecoveryMetrics | null): number | null {
  if (!metrics) return null
  // We derive an aggregate health score from the metrics envelope. The
  // recovery-metrics route exposes success-rate as 0-100; use it as the
  // primary signal. A future ticket could fold MTTR + cost into a
  // weighted score; v1 surfaces the most legible number an operator
  // already understands.
  const value = metrics.successRate.value
  if (value === null || Number.isNaN(value)) return null
  return Math.round(value)
}

function readDisplayName(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null
  const meta = (user as { user_metadata?: { full_name?: unknown; name?: unknown }, email?: unknown }).user_metadata
  if (meta && typeof meta.full_name === 'string' && meta.full_name.length > 0) {
    return meta.full_name.split(' ')[0] ?? null
  }
  if (meta && typeof meta.name === 'string' && meta.name.length > 0) {
    return meta.name.split(' ')[0] ?? null
  }
  const email = (user as { email?: unknown }).email
  if (typeof email === 'string' && email.includes('@')) {
    return email.split('@')[0] ?? null
  }
  return null
}

// Re-export helpers under stable names so tests can import them directly.
export { humanizeAge, readErrorSignature }
