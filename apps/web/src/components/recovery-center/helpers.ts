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
 * The data-shape types mirror the API envelopes the existing panels read
 * (`GET /recovery/metrics`, `GET /dlq/clusters`, `GET /billing/budget`).
 *
 * Used by `../RecoveryCenterPanel.test.tsx` — `computeRecommendedActions`
 * and `buildGreeting` are unit-tested here directly (no React render
 * needed).
 */

import { t as runtimeT } from '../../i18n/runtime'
import type { ActiveTab, RunSummary } from '../../types'
import type { DeadLetter } from '../DeadLettersPanel'

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

/** One per-day point of the MTTR trend sparkline; `day` is `YYYY-MM-DD`. */
export type MttrTrendPoint = { day: string; seconds: number }

export type RecoveryMetrics = {
  successRate: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  slaAttainment?: RecoveryMetric
  clustersResolved?: ClustersResolvedMetric
  valueEstimate?: ValueEstimate
  windowDays: number
  terminalRuns: number
  /** Per-day avg recovery time (last ≤14 days, oldest-first) for the MTTR sparkline. Optional — older API responses omit it. */
  mttrTrend?: MttrTrendPoint[]
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

export function humanizeAge(iso: string | undefined, nowMs: number | null): string {
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
  // recovery-metrics route exposes success-rate as 0-100; use it as the
  // primary signal. A future ticket could fold MTTR + cost into a
  // weighted score; v1 surfaces the most legible number an operator
  // already understands.
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
