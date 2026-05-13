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
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  Coins,
  Compass,
  Gauge,
  Inbox,
  Layers,
  PlayCircle,
  RefreshCw,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import type { ActiveTab, JsonObject, RunNode, RunSummary } from '../types'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'

// ─────────────────────────────────────────────────────────────────────────
// Types / data shapes — mirror the API envelopes the existing panels read.
// ─────────────────────────────────────────────────────────────────────────

type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
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
  const band = healthBand(score)
  const reducedMotion = usePrefersReducedMotion()
  const target = score ?? 0
  const animated = useAnimatedNumber(target, 800, reducedMotion)
  const ratio = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100
  const dashoffset = HEALTH_RING_CIRCUMFERENCE * (1 - ratio)
  const radius = (HEALTH_RING_SIZE - HEALTH_RING_STROKE) / 2
  return (
    <div className="we-recovery-center-ring" data-band={band} aria-label={score === null ? 'Health score pending' : `Health score ${score} of 100`}>
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
        <small className="we-recovery-center-ring__caption">Health</small>
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
      aria-label={`${label}: ${display}. ${rationale}. Open detail.`}
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
      title: `Resolve ${signals.pendingApprovals} approval${signals.pendingApprovals === 1 ? '' : 's'} waiting on input`,
      body: 'A run is paused waiting for a human decision. Open the form to complete or reject.',
      ctaLabel: 'Open runs',
      ctaTab: 'runs',
      severity: 'warning',
    })
  }
  if (signals.topClusterFrequency >= 2) {
    actions.push({
      id: 'recover_cluster',
      title: `Recover all ${signals.topClusterFrequency} matching failures in one pass`,
      body: 'A cluster of failures shares the same root cause. Apply one fix to all of them via the Recovery dialog.',
      ctaLabel: 'Open clusters',
      ctaTab: 'operations',
      severity: 'cobalt',
    })
  }
  if (signals.openFailures > 0) {
    actions.push({
      id: 'triage_failures',
      title: `Open the Recovery Queue to triage ${signals.openFailures} failure${signals.openFailures === 1 ? '' : 's'}`,
      body: 'Each failed run carries the original error, attempts, and a suggested fix you can sandbox-replay.',
      ctaLabel: 'Open queue',
      ctaTab: 'runs',
      severity: 'warning',
    })
  }
  if (signals.healthScore !== null && signals.healthScore < 80) {
    const severity: RecommendedActionSeverity = signals.healthScore < 60 ? 'danger' : 'warning'
    actions.push({
      id: 'review_workflow_risk',
      title: 'Review workflow risk in Operations',
      body: 'Health score is below 80. Operations shows MTTR, success rate, p95 latency, and cost — fix the worst tile first.',
      ctaLabel: 'Open Operations',
      ctaTab: 'operations',
      severity,
    })
  }
  if (signals.totalRuns < 5 && signals.openFailures === 0 && signals.pendingApprovals === 0) {
    actions.push({
      id: 'run_getting_started',
      title: 'Run the Getting Started demo',
      body: 'See the recovery loop end-to-end with a deliberately broken example. Takes 60 seconds.',
      ctaLabel: 'Browse recipes',
      ctaTab: 'templates',
      severity: 'cyan',
    })
  }
  if (actions.length === 0) {
    actions.push({
      id: 'healthy_try_studio',
      title: 'Everything looks healthy — try AI Studio to draft a flow',
      body: 'No failures, no waiting approvals, no recurring patterns. A perfect moment to author the next workflow.',
      ctaLabel: 'Open AI Studio',
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
  const slot = args.hour < 12 ? 'morning' : args.hour < 18 ? 'afternoon' : 'evening'
  const who = args.displayName ?? 'there'
  const salutation = `Good ${slot}, ${who}.`
  let subline: string
  if (args.totalRuns === 0) {
    subline = 'Welcome to Janusly. The Recovery Center fills in as workflows run.'
  } else if (args.pendingApprovals > 0) {
    subline = `${args.pendingApprovals} approval${args.pendingApprovals === 1 ? '' : 's'} waiting on input.`
  } else if (args.openFailures > 0) {
    subline = `${args.openFailures} run${args.openFailures === 1 ? '' : 's'} need${args.openFailures === 1 ? 's' : ''} recovery.`
  } else if (args.healthScore !== null && args.healthScore >= 80) {
    subline = `All clear — health is at ${args.healthScore}.`
  } else if (args.healthScore !== null) {
    subline = `Stable, but health is at ${args.healthScore}. Worth a glance.`
  } else {
    subline = 'Recovery posture is clean across the last 30 days.'
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
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function readErrorSignature(errorJson: unknown): string {
  if (!errorJson || typeof errorJson !== 'object') return 'Failed'
  const candidate = (errorJson as { signature?: unknown; message?: unknown; error?: unknown })
  if (typeof candidate.signature === 'string') return candidate.signature
  if (typeof candidate.message === 'string') return candidate.message
  if (typeof candidate.error === 'string') return candidate.error
  return 'Failed'
}

function readWorkflowName(dlq: DeadLetter, runs: RunSummary[]): string {
  const fromWorkflow = (dlq.workflowJson as { name?: unknown } | null | undefined)?.name
  if (typeof fromWorkflow === 'string' && fromWorkflow.length > 0) return fromWorkflow
  const run = runs.find((entry) => entry.id === dlq.runId)
  if (run?.workflowVersionId) return run.workflowVersionId
  return '(ad-hoc workflow)'
}

const CLUSTER_CATEGORY_LABEL: Record<ClusterCategory, string> = {
  secret_missing: 'Secret',
  http_error: 'HTTP',
  network_timeout: 'Timeout',
  ai_provider: 'AI',
  parse_error: 'Parse',
  tool_input: 'Tool input',
  unknown: 'Unknown',
}

const CLUSTER_OWNER_LABEL: Record<ClusterOwner, string> = {
  ops: 'ops',
  workflow_author: 'workflow author',
  platform: 'platform',
}

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterPanel — the main composer.
// ─────────────────────────────────────────────────────────────────────────

export function RecoveryCenterPanel(props: RecoveryCenterPanelProps) {
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
        setMetricsError(err instanceof Error ? err.message : 'Recovery metrics unavailable')
        setMetricsLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion])

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
  const greeting = useMemo(() => buildGreeting({
    hour: currentHour,
    displayName: readDisplayName(user),
    openFailures: openDeadLetters.length,
    pendingApprovals: waitingNodes.length,
    healthScore,
    totalRuns,
  }), [currentHour, user, openDeadLetters.length, waitingNodes.length, healthScore, totalRuns])

  const recommendedActions = useMemo(() => computeRecommendedActions({
    openFailures: openDeadLetters.length,
    pendingApprovals: waitingNodes.length,
    topClusterFrequency,
    healthScore,
    totalRuns,
  }), [openDeadLetters.length, waitingNodes.length, topClusterFrequency, healthScore, totalRuns])

  const isEmpty = openDeadLetters.length === 0
    && waitingNodes.length === 0
    && (clusters?.clusters.length ?? 0) === 0
    && totalRuns === 0

  return (
    <div className="we-recovery-center-panel">
      <header className="we-recovery-center-hero" role="banner">
        <div className="we-recovery-center-hero__copy">
          <div className="section-kicker">Recovery Center</div>
          <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">{greeting.salutation}</h1>
          <p className="we-recovery-center-hero__subline">{greeting.subline}</p>
        </div>
        <HealthRing score={healthScore} />
      </header>

      <section className="we-recovery-center-strip" aria-label="Recovery metric strip">
        <RecoveryCenterMetric
          label="Open failures"
          display={openDeadLetters.length === 0 ? '0' : String(openDeadLetters.length)}
          numericValue={openDeadLetters.length}
          severity={openDeadLetters.length === 0 ? 'healthy' : openDeadLetters.length > 5 ? 'unhealthy' : 'warn'}
          icon={<AlertTriangle size={16} aria-hidden="true" />}
          rationale={openDeadLetters.length === 0 ? 'Nothing in the recovery queue' : 'Awaiting triage'}
          onClick={() => props.onOpenTab('runs')}
          testId="recovery-center-metric-failures"
        />
        <RecoveryCenterMetric
          label="MTTR (p50)"
          display={metrics?.mttr.display ?? '—'}
          numericValue={metrics?.mttr.value ?? null}
          severity={metrics?.mttr.severity ?? 'neutral'}
          icon={<RefreshCw size={16} aria-hidden="true" />}
          rationale={metrics?.mttr.rationale ?? 'Mean time to recovery'}
          onClick={() => props.onOpenTab('operations')}
          testId="recovery-center-metric-mttr"
        />
        <RecoveryCenterMetric
          label="Approvals pending"
          display={waitingNodes.length === 0 ? '0' : String(waitingNodes.length)}
          numericValue={waitingNodes.length}
          severity={waitingNodes.length === 0 ? 'healthy' : 'warn'}
          icon={<Users size={16} aria-hidden="true" />}
          rationale={waitingNodes.length === 0 ? 'No human action required' : 'Operators waiting on a decision'}
          onClick={() => props.onOpenTab('runs')}
          testId="recovery-center-metric-approvals"
        />
        <RecoveryCenterMetric
          label="Replay success"
          display={metrics?.replayRate.display ?? '—'}
          numericValue={metrics?.replayRate.value ?? null}
          severity={metrics?.replayRate.severity ?? 'neutral'}
          icon={<Zap size={16} aria-hidden="true" />}
          rationale={metrics?.replayRate.rationale ?? 'Sandbox + production replays combined'}
          onClick={() => props.onOpenTab('operations')}
          testId="recovery-center-metric-replay"
        />
      </section>

      {isEmpty ? (
        <RecoveryCenterEmptyHero
          onOpenStudio={() => props.onOpenTab('copilot')}
          onOpenRecipes={() => props.onOpenTab('templates')}
        />
      ) : (
        <div className="we-recovery-center-grid">
          <RecoveryQueueTile
            deadLetters={openDeadLetters}
            runs={props.runs}
            nowMs={nowMs}
            onOpenRun={props.onOpenRun}
            onOpenTab={props.onOpenTab}
          />
          <FailureClustersTile
            clusters={topClusters}
            totalSamples={clusters?.totalSamples ?? 0}
            onOpenTab={props.onOpenTab}
          />
          <PendingApprovalsTile
            waitingNodes={waitingNodes}
            runs={props.runs}
            onOpenRun={props.onOpenRun}
            onOpenTab={props.onOpenTab}
          />
          <RecommendedActionsTile
            actions={recommendedActions}
            onOpenTab={props.onOpenTab}
          />
          <BudgetTile onOpenTab={props.onOpenTab} />
        </div>
      )}

      {metricsError && !metricsLoading && (
        <p className="we-recovery-center-error" role="status">
          Metrics unavailable — {metricsError}. The Recovery Center still renders with what we have.
        </p>
      )}
    </div>
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
  const top = deadLetters.slice(0, 3)
  return (
    <RecoveryCenterTile
      title="Recovery Queue"
      kicker="Failures"
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
          Open queue <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <p className="we-recovery-center-tile__empty">No failed runs in the last 30 days — nice.</p>
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
  return (
    <RecoveryCenterTile
      title="Failure clusters"
      kicker={`${totalSamples} samples`}
      severity={clusters.length === 0 ? 'success' : 'cobalt'}
      icon={<Layers size={18} aria-hidden="true" />}
      testId="recovery-center-tile-clusters"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
          data-testid="recovery-center-clusters-open-all"
        >
          Open clusters <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {clusters.length === 0 ? (
        <p className="we-recovery-center-tile__empty">No recurring patterns yet — failures look unique.</p>
      ) : (
        <ul className="we-recovery-center-rows">
          {clusters.map((cluster) => (
            <li key={cluster.signature}>
              <div className="we-recovery-center-row" data-static="true">
                <span className="we-recovery-center-row__title">{cluster.signature}</span>
                <span className="we-recovery-center-row__meta">
                  <span className="we-recovery-center-row__pill" data-severity="cobalt">{cluster.frequency}×</span>
                  <span className="we-recovery-center-row__pill" data-severity="cyan">{CLUSTER_CATEGORY_LABEL[cluster.category]}</span>
                  <span className="we-recovery-center-row__pill" data-severity="neutral">{CLUSTER_OWNER_LABEL[cluster.suggestedOwner]}</span>
                </span>
              </div>
            </li>
          ))}
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
}: {
  waitingNodes: RunNode[]
  runs: RunSummary[]
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
}) {
  const top = waitingNodes.slice(0, 3)
  return (
    <RecoveryCenterTile
      title="Pending approvals"
      kicker="Human action"
      severity={waitingNodes.length === 0 ? 'success' : 'warning'}
      icon={<Users size={18} aria-hidden="true" />}
      testId="recovery-center-tile-approvals"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('runs')}
          data-testid="recovery-center-approvals-open-all"
        >
          Open runs <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <p className="we-recovery-center-tile__empty">No approvals waiting — all runs are progressing.</p>
      ) : (
        <ul className="we-recovery-center-rows">
          {top.map((node) => {
            const waiting = (node.stateJson as { waiting?: { kind?: string; title?: string } } | undefined)?.waiting
            const kind = waiting?.kind ?? 'approval'
            const title = waiting?.title ?? (kind === 'human_form' ? 'Form awaiting input' : 'Approval requested')
            const matchingRun = runs.find((entry) => entry.workflowVersionId && entry.status === 'paused')
            const runId = matchingRun?.id
            return (
              <li key={node.nodeId}>
                <button
                  type="button"
                  className="we-recovery-center-row"
                  onClick={() => {
                    if (runId) void onOpenRun(runId)
                    onOpenTab('runs')
                  }}
                  data-testid={`recovery-center-approvals-row-${node.nodeId}`}
                >
                  <span className="we-recovery-center-row__title">{title}</span>
                  <span className="we-recovery-center-row__meta">
                    <code className="we-recovery-center-row__node">{node.nodeId}</code>
                    <span className="we-recovery-center-row__pill" data-severity="warning">{kind === 'human_form' ? 'Form' : 'Approval'}</span>
                  </span>
                  <span className="we-recovery-center-row__age">waiting</span>
                </button>
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
      title="Recommended next actions"
      kicker="Suggestions"
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
        setError(err instanceof Error ? err.message : 'Budget unavailable')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion])

  const band = budgetBand(envelope)
  const tileSeverity: 'cobalt' | 'cyan' | 'success' | 'warning' | 'danger' = band === 'danger' ? 'danger' : band === 'warning' ? 'warning' : band === 'success' ? 'success' : band === 'cyan' ? 'cyan' : 'cobalt'
  const limit = envelope?.monthlyUsdLimit ?? null
  const spent = envelope?.monthlyUsdSpent ?? 0
  const hasBudget = limit !== null && limit > 0
  const ratio = hasBudget ? Math.min(1, spent / (limit ?? 1)) : 0
  const formatMoney = (value: number) => `$${value.toFixed(2)}`

  return (
    <RecoveryCenterTile
      title="AI budget"
      kicker={hasBudget ? `${(ratio * 100).toFixed(0)}% used` : 'Not configured'}
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
          {hasBudget ? 'Open settings' : 'Set a budget'} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {loading && <p className="we-recovery-center-tile__empty">Loading budget…</p>}
      {error && (
        <p className="we-recovery-center-tile__empty" role="status">Budget unavailable — {error}.</p>
      )}
      {!loading && !error && !hasBudget && (
        <p className="we-recovery-center-tile__empty">
          No monthly budget configured. Set one in Operations to surface MTD spend and gate runaway AI spend.
        </p>
      )}
      {!loading && !error && hasBudget && (
        <div className="we-recovery-center-budget" data-testid="recovery-center-budget-bar" data-band={band}>
          <div className="we-recovery-center-budget__row">
            <span className="we-recovery-center-budget__label">MTD spend</span>
            <span className="we-recovery-center-budget__value">{formatMoney(spent)} / {formatMoney(limit ?? 0)}</span>
          </div>
          <div className="we-recovery-center-budget__bar" role="presentation" aria-hidden="true">
            <span className="we-recovery-center-budget__bar-rail" />
            <span
              className={`we-recovery-center-budget__bar-fill we-recovery-center-budget__bar-fill--${band}`}
              style={{ width: `${Math.max(2, ratio * 100)}%` }}
            />
          </div>
          <div className="we-recovery-center-budget__meta">
            <span>Policy: <code>{envelope?.policy ?? 'warn'}</code></span>
            {envelope?.warningThresholdCrossed && (
              <span className="we-recovery-center-budget__pill" data-severity={band}>over warning</span>
            )}
          </div>
        </div>
      )}
    </RecoveryCenterTile>
  )
}

function RecoveryCenterEmptyHero({
  onOpenStudio,
  onOpenRecipes,
}: {
  onOpenStudio: () => void
  onOpenRecipes: () => void
}) {
  return (
    <section className="we-recovery-center-empty" aria-labelledby="recovery-center-empty-title" data-testid="recovery-center-empty">
      <div className="we-recovery-center-empty__circle" aria-hidden="true">
        <Compass size={36} aria-hidden="true" />
      </div>
      <div className="we-recovery-center-empty__copy">
        <h2 id="recovery-center-empty-title">Welcome to Janusly</h2>
        <p>
          Your Recovery Center will fill in as workflows run. Start with a recipe or
          draft a flow in AI Studio — the first run flips the page into the live view.
        </p>
      </div>
      <div className="we-recovery-center-empty__ctas">
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={onOpenStudio}
          data-testid="recovery-center-empty-cta-studio"
        >
          <Sparkles size={16} aria-hidden="true" />
          Open AI Studio
        </button>
        <button
          type="button"
          className="command-button"
          onClick={onOpenRecipes}
          data-testid="recovery-center-empty-cta-recipes"
        >
          <Workflow size={16} aria-hidden="true" />
          Browse Recipes
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
