/**
 * Recovery Center — pure helpers + data-shape types.
 *
 * Zero React: every function here is a deterministic pure function (the
 * label/reader helpers call the non-React translation accessor `runtimeT`,
 * the same pattern the panel used before the split). Co-located with the
 * Recovery Center components under `recovery-center/`; consumed by the
 * composer (`../RecoveryCenterPanel.tsx`), the tile family
 * (`./RecoveryCenterTiles.tsx`), and `./HealthRing.tsx`.
 *
 * The data-shape types mirror the API envelopes the existing panels read,
 * including the coalesced Recovery Home snapshot and the budget endpoint.
 *
 * Used by `../RecoveryCenterPanel.test.tsx` — `computeRecommendedActions`
 * and `buildGreeting` are unit-tested here directly (no React render
 * needed).
 */

import { t as runtimeT } from '../../i18n/runtime'
import type { ActiveTab, RunNode, RunSummary } from '../../types'
import type { DeadLetter } from '../dead-letter-types'
import { isOpenRunStatus } from '@janusly/shared/src/status'

// ─────────────────────────────────────────────────────────────────────────
// Types / data shapes — mirror the API envelopes the existing panels read.
// ─────────────────────────────────────────────────────────────────────────

export type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

export type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

export type ClustersResolvedMetric = RecoveryMetric & {
  totalEntries: number
  capped: boolean
}

export type ValueEstimate = {
  hoursSaved: number
  dollarSaved: number
  mttrDeltaSeconds: number | null
  assumptions: {
    hourlyCost: number
    minutesSavedPerRecovery: number
    baselineMttrSeconds: number
  }
}

/** One per-day median verified-recovery point; `day` is `YYYY-MM-DD`. */
export type MttrTrendPoint = { day: string; seconds: number }

export type RecoveryMetrics = {
  successRate: RecoveryMetric
  verifiedRecovery?: RecoveryMetric & {
    definitionVersion: '1'
    metric: 'time_to_verified_recovery'
    unit: 'milliseconds'
    sampleSize: number
    p50Ms: number | null
    p90Ms: number | null
  }
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  slaAttainment?: RecoveryMetric
  timeToFirstAction?: RecoveryMetric
  recurrenceRate?: RecoveryMetric
  clustersResolved?: ClustersResolvedMetric
  valueEstimate?: ValueEstimate
  windowDays: number
  terminalRuns: number
  /** Per-day median verified-recovery time (last ≤14 days, oldest-first). Optional — older API responses omit it. */
  mttrTrend?: MttrTrendPoint[]
  /** Total automation downtime closed in the window (ms). Optional — older API responses omit it. */
  downtimeEndedMs?: number
}

export type RecoveryLedger = {
  totalRecovered: number
  downtimeEndedMs: number
  sinceIso: string | null
}

export type OperatorWins = {
  recovered: number
  windowDays: number
}

export type ClusterCategory =
  | 'secret_missing'
  | 'http_error'
  | 'network_timeout'
  | 'ai_provider'
  | 'parse_error'
  | 'tool_input'
  | 'unknown'

export type ClusterOwner = 'ops' | 'workflow_author' | 'platform'

export type FailureCluster = {
  signature: string
  category: ClusterCategory
  frequency: number
  suggestedOwner: ClusterOwner
  lastSeen: string
  /** True when this normalized signature returned after a terminal recovery. */
  recurredAfterRecovery?: boolean
}

export type ClustersResponse = {
  clusters: FailureCluster[]
  totalSamples: number
  windowDays: number
}

export type BudgetEnvelope = {
  allowed?: boolean
  monthlyUsdSpent?: number
  monthlyUsdLimit?: number | null
  policy?: 'warn' | 'block'
  warningPercent?: number
  warningThresholdCrossed?: boolean
  exceededAt?: 'org' | 'workflow' | null
  resolvedScope?: 'org' | 'workflow' | null
}

/** Read-only calibration status returned by `GET /recovery/calibration-status`. */
export type CalibrationStatusEnvelope = {
  enabled: boolean
  windowDays: number
  minimumSampleSize: number
  calibrations: Array<{
    approachLabel: string
    acceptRate: number
    sampleSize: number
    curveSlope: number
    curveIntercept: number
    lastComputedAt: string | null
  }>
}

/**
 * Count distinct waiting runs from the bounded platform projection. The
 * selected-run node fallback covers the short bootstrap interval before that
 * run appears in the list without counting it twice afterward.
 */
export function countActiveRecoveryBlockers(
  runs: readonly RunSummary[],
  runNodes: readonly RunNode[],
  selectedRunId: string | null,
  semanticBlockerRunIds: readonly string[] = [],
): number {
  const waitingRunIds = new Set(
    runs
      .filter((run) => run.status === 'waiting')
      .map((run) => run.id),
  )
  for (const runId of semanticBlockerRunIds) {
    waitingRunIds.add(runId)
  }
  if (
    selectedRunId
    && !waitingRunIds.has(selectedRunId)
    && runNodes.some((node) => node.status === 'waiting')
  ) {
    waitingRunIds.add(selectedRunId)
  }
  return waitingRunIds.size
}

// ─────────────────────────────────────────────────────────────────────────
// Health band — drives the HealthRing stroke colour: cobalt ≥80, amber
// 60-79, red <60.
// ─────────────────────────────────────────────────────────────────────────

export function healthBand(score: number | null): 'high' | 'mid' | 'low' | 'unknown' {
  if (score === null || Number.isNaN(score)) return 'unknown'
  if (score >= 80) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

// ─────────────────────────────────────────────────────────────────────────
// Recommended actions — pure helper.
// ─────────────────────────────────────────────────────────────────────────

export type RecommendedActionId =
  | 'resolve_approvals'
  | 'review_semantic_cases'
  | 'recover_cluster'
  | 'triage_failures'
  | 'review_workflow_risk'

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
  semanticCases: number
  topClusterFrequency: number
  healthScore: number | null
}

/**
 * Deterministic priority of recommended next actions. Operator-blocking
 * work first (approvals waiting on input), then semantic containment,
 * bulk recovery, individual triage, and long-term risk. Pure function
 * so each ordering rule can be tested in isolation.
 */
export function computeRecommendedActions(signals: RecommendedActionSignals): RecommendedAction[] {
  const actions: RecommendedAction[] = []
  if (signals.pendingApprovals > 0) {
    actions.push({
      id: 'resolve_approvals',
      title: runtimeT('recoveryCenter.action.resolve_approvals.title', { count: signals.pendingApprovals }),
      body: runtimeT('recoveryCenter.action.resolve_approvals.body'),
      ctaLabel: runtimeT('recoveryCenter.action.resolve_approvals.cta'),
      ctaTab: 'recover',
      severity: 'warning',
    })
  }
  if (signals.semanticCases > 0) {
    actions.push({
      id: 'review_semantic_cases',
      title: runtimeT('recoveryCenter.action.review_semantic_cases.title', {
        count: signals.semanticCases,
      }),
      body: runtimeT('recoveryCenter.action.review_semantic_cases.body'),
      ctaLabel: runtimeT('recoveryCenter.action.review_semantic_cases.cta'),
      ctaTab: 'recover',
      severity: 'danger',
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
  } else if (signals.openFailures > 0) {
    actions.push({
      id: 'triage_failures',
      title: runtimeT('recoveryCenter.action.triage_failures.title', { count: signals.openFailures }),
      body: runtimeT('recoveryCenter.action.triage_failures.body'),
      ctaLabel: runtimeT('recoveryCenter.action.triage_failures.cta'),
      ctaTab: 'recover',
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
  return actions.slice(0, 3)
}

export function listActiveRuns(runs: readonly RunSummary[], limit = 3): RunSummary[] {
  const boundedLimit = Math.max(0, Math.floor(limit))
  return runs
    .filter((run) => isOpenRunStatus(run.status))
    .slice()
    .sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
    })
    .slice(0, boundedLimit)
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
  semanticOutcomePosture: 'loading' | 'unavailable' | 'attention' | 'clear'
  semanticCaseCount: number
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
  if (args.semanticOutcomePosture === 'attention') {
    subline = runtimeT('recoveryCenter.greeting.subline.semanticCases', {
      count: args.semanticCaseCount,
    })
  } else if (args.semanticOutcomePosture === 'unavailable') {
    subline = runtimeT('recoveryCenter.greeting.subline.semanticUnavailable')
  } else if (args.semanticOutcomePosture === 'loading') {
    subline = runtimeT('recoveryCenter.greeting.subline.semanticLoading')
  } else if (args.totalRuns === 0) {
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
// Budget band — drives the BudgetTile bar colour from the spend ratio.
// ─────────────────────────────────────────────────────────────────────────

export function budgetBand(envelope: BudgetEnvelope | null): 'cobalt' | 'cyan' | 'success' | 'warning' | 'danger' {
  if (!envelope || envelope.monthlyUsdLimit == null || envelope.monthlyUsdLimit === 0) return 'cyan'
  const ratio = (envelope.monthlyUsdSpent ?? 0) / envelope.monthlyUsdLimit
  if (ratio >= 1) return 'danger'
  if (ratio >= (envelope.warningPercent ?? 80) / 100) return 'warning'
  return 'cobalt'
}

// ─────────────────────────────────────────────────────────────────────────
// Small readers / labelers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Whether to show the onboarding recovery-loop walkthrough. Only for a truly
 * fresh workspace — no runs, no open failures, no pending approvals — so an
 * established org that simply has nothing failing right now doesn't get taught
 * the loop every visit. A prior dismissal always wins.
 */
export function shouldShowOnboarding(input: {
  runs: number
  openFailures: number
  waitingApprovals: number
  dismissed: boolean
}): boolean {
  if (input.dismissed) return false
  return input.runs === 0 && input.openFailures === 0 && input.waitingApprovals === 0
}

/** One per-day cell from `GET /recovery/heatmap`. */
export type HeatmapDay = { day: string; failures: number; recovered: number; mttrSeconds: number }
export type HeatmapOutcome = 'none' | 'recovered' | 'partial' | 'unrecovered'
export type HeatmapCell = { day: string; failures: number; recovered: number; outcome: HeatmapOutcome }
export type StreakSummary = { current: number; longest: number }
export type OpenDowntimeSummary = { createdAt: string; durationMs: number }

/** Classify a day's failure/recovery counts into a heatmap color band. */
export function heatmapOutcome(failures: number, recovered: number): HeatmapOutcome {
  if (failures <= 0) return 'none'
  if (recovered >= failures) return 'recovered'
  if (recovered > 0) return 'partial'
  return 'unrecovered'
}

/**
 * Densify the sparse API rows (only days with failures) into a contiguous
 * last-`windowDays` grid, oldest→newest, filling missing days as zero. `nowMs`
 * is injected for deterministic tests. Day keys are UTC (`YYYY-MM-DD`) to match
 * the API's `date_trunc('day', …)` bucketing.
 */
export function buildHeatmapCells(days: HeatmapDay[], windowDays: number, nowMs: number): HeatmapCell[] {
  const byDay = new Map(days.map((d) => [d.day, d]))
  const dayMs = 86_400_000
  const bounded = Math.min(90, Math.max(1, Math.floor(windowDays)))
  const cells: HeatmapCell[] = []
  for (let i = bounded - 1; i >= 0; i--) {
    const key = new Date(nowMs - i * dayMs).toISOString().slice(0, 10)
    const row = byDay.get(key)
    const failures = row?.failures ?? 0
    const recovered = row?.recovered ?? 0
    cells.push({ day: key, failures, recovered, outcome: heatmapOutcome(failures, recovered) })
  }
  return cells
}

/**
 * Count contiguous clean days from the first observable recovery activity.
 * Empty densified cells after that anchor are clean, but leading cells are not
 * evidence that a newly observed workspace has been healthy for the full
 * reporting window.
 */
export function computeStreaks(cells: HeatmapCell[]): StreakSummary {
  const firstObservedIndex = cells.findIndex((cell) => cell.failures > 0 || cell.recovered > 0)
  if (firstObservedIndex < 0) return { current: 0, longest: 0 }
  const observedCells = cells.slice(firstObservedIndex)
  let current = 0
  let longest = 0
  let running = 0

  for (const cell of observedCells) {
    const clean = cell.failures === 0 || cell.recovered >= cell.failures
    running = clean ? running + 1 : 0
    longest = Math.max(longest, running)
  }

  for (let index = observedCells.length - 1; index >= 0; index -= 1) {
    const cell = observedCells[index]
    if (!cell || (cell.failures > 0 && cell.recovered < cell.failures)) break
    current += 1
  }

  return { current, longest }
}

/** Find the oldest valid open failure using the Recovery Center's shared clock. */
export function computeLongestOpenDowntime(
  items: ReadonlyArray<{ createdAt?: string }>,
  nowMs: number | null,
): OpenDowntimeSummary | null {
  if (nowMs === null || !Number.isFinite(nowMs)) return null
  let longest: OpenDowntimeSummary | null = null
  for (const item of items) {
    if (!item.createdAt) continue
    const createdAtMs = new Date(item.createdAt).getTime()
    const durationMs = nowMs - createdAtMs
    if (!Number.isFinite(durationMs) || durationMs < 0) continue
    if (!longest || durationMs > longest.durationMs) {
      longest = { createdAt: item.createdAt, durationMs }
    }
  }
  return longest
}

export type DowntimeSeverity = 'ok' | 'warn' | 'danger'

/** Downtime-clock thresholds in minutes (amber ≥1h, red ≥4h). */
export const DOWNTIME_WARN_MINUTES = 60
export const DOWNTIME_DANGER_MINUTES = 240

/**
 * Severity for how long an open failure has been down. Fixed heuristic
 * thresholds — the DLQ row carries no per-item SLA — so an operator sees a
 * failure warm from neutral → amber (≥1h) → red (≥4h) the longer it sits.
 * Returns 'ok' when the clock isn't ready or the timestamp is unusable.
 */
export function downtimeSeverity(iso: string | undefined, nowMs: number | null): DowntimeSeverity {
  if (nowMs === null || !iso) return 'ok'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'ok'
  const minutes = (nowMs - then) / 60000
  if (minutes >= DOWNTIME_DANGER_MINUTES) return 'danger'
  if (minutes >= DOWNTIME_WARN_MINUTES) return 'warn'
  return 'ok'
}

export type DurationStyle = 'clock' | 'age'

/**
 * Canonical compact duration formatter for every Recovery Center surface.
 * `clock` is terse measured time (`3h 14m`); `age` is localized relative
 * copy (`3h ago`). Invalid or negative input stays empty rather than leaking
 * `NaN` into operator-facing text.
 */
export function formatDuration(ms: number, style: DurationStyle = 'clock'): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  if (style === 'age') {
    if (totalSeconds < 60) return runtimeT('recoveryCenter.relative.seconds', { count: totalSeconds })
    const totalMinutes = Math.floor(totalSeconds / 60)
    if (totalMinutes < 60) return runtimeT('recoveryCenter.relative.minutes', { count: totalMinutes })
    const hours = Math.floor(totalMinutes / 60)
    if (hours < 48) return runtimeT('recoveryCenter.relative.hours', { count: hours })
    return runtimeT('recoveryCenter.relative.days', { count: Math.floor(hours / 24) })
  }

  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

/** @deprecated Prefer `formatDuration(ms)` in new Recovery Center code. */
export function formatDowntime(ms: number): string {
  return formatDuration(ms)
}

export function humanizeAge(iso: string | undefined, nowMs: number | null): string {
  if (nowMs === null) return ''
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  return formatDuration(Math.max(0, nowMs - then), 'age')
}

export function readErrorSignature(errorJson: unknown): string {
  const fallback = runtimeT('recoveryCenter.errorSignatureFallback')
  if (!errorJson || typeof errorJson !== 'object') return fallback
  const candidate = (errorJson as { signature?: unknown; message?: unknown; error?: unknown })
  if (typeof candidate.signature === 'string') return candidate.signature
  if (typeof candidate.message === 'string') return candidate.message
  if (typeof candidate.error === 'string') return candidate.error
  return fallback
}

export function readWorkflowName(dlq: DeadLetter, runs: RunSummary[]): string {
  // List rows carry the cheap `workflowName` projection; detail rows carry
  // the full snapshot. Prefer whichever is present.
  if (typeof dlq.workflowName === 'string' && dlq.workflowName.length > 0) return dlq.workflowName
  const fromWorkflow = (dlq.workflowJson as { name?: unknown } | null | undefined)?.name
  if (typeof fromWorkflow === 'string' && fromWorkflow.length > 0) return fromWorkflow
  const run = runs.find((entry) => entry.id === dlq.runId)
  if (run?.workflowVersionId) return run.workflowVersionId
  return runtimeT('recoveryCenter.adHocWorkflow')
}

export function clusterCategoryLabel(category: ClusterCategory): string {
  return runtimeT(`recoveryCenter.cluster.category.${category}`)
}

export function clusterOwnerLabel(owner: ClusterOwner): string {
  return runtimeT(`recoveryCenter.cluster.owner.${owner}`)
}

export function readHealthScore(metrics: RecoveryMetrics | null): number | null {
  if (!metrics) return null
  // We derive an aggregate health score from the metrics envelope. The
  // recovery-metrics route exposes success-rate as 0-100, so it remains the
  // primary signal instead of mixing metrics with incompatible units into an
  // opaque weighted score.
  const value = metrics.successRate.value
  if (value === null || Number.isNaN(value)) return null
  return Math.round(value)
}

export function readDisplayName(user: unknown): string | null {
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
