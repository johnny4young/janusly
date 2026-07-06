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
 * - `GET /dlq?status=open` → recovery-queue tile (via props).
 * - `GET /dlq/clusters` → failure-clusters tile.
 * - Run nodes from the store (`status === "waiting"`) → pending approvals.
 *
 * The Recovery Center is composition over the recovery API + engine metrics.
 * Each child tile refetches independently on the cross-panel
 * `platformVersion` tick (same pattern OperationsPage uses today).
 *
 * Used by `App.tsx` for `activeTab === 'home'`.
 *
 * Design language: see the `Recovery Center` block in
 * `apps/web/src/index.css`. Tokens-only, no inline hex. Animations
 * honour `prefers-reduced-motion`. Tab order: hero → metric strip →
 * tiles → recommended actions → empty-state CTAs.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Target, Users, Zap } from 'lucide-react'
import type { ActiveTab, JsonObject, RunNode, RunSummary } from '../types'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'
import { tRecoveryMetricRationale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { ValueDashboardSection } from './ValueDashboardSection'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from './VitalSignsStrip'
import {
  buildGreeting,
  computeRecommendedActions,
  readDisplayName,
  readHealthScore,
  type ClustersResponse,
  type RecoveryMetrics,
} from './recovery-center/helpers'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { RecoveryCenterComposer } from './recovery-center/RecoveryCenterComposer'
import {
  BudgetTile,
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
}

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

  const failuresLabel = t('recoveryCenter.metric.failures.label') as string
  const failuresDisplay = openDeadLetters.length === 0 ? '0' : String(openDeadLetters.length)
  const failuresRationale = openDeadLetters.length === 0
    ? t('recoveryCenter.metric.failures.rationaleEmpty') as string
    : t('recoveryCenter.metric.failures.rationale') as string
  const homeTiles: VitalSignsTile[] = [
    {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      label: failuresLabel,
      display: failuresDisplay,
      numericValue: openDeadLetters.length,
      severity: openDeadLetters.length === 0 ? 'healthy' : openDeadLetters.length > 5 ? 'unhealthy' : 'warn',
      rationale: failuresRationale,
      ariaLabel: t('recoveryCenter.metric.aria', { label: failuresLabel, display: failuresDisplay, rationale: failuresRationale }) as string,
      onClick: () => props.onOpenTab('runs'),
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
  // MTTR trend sparkline: needs ≥2 daily points to tell a story.
  const mttrTrendSeconds = (metrics?.mttrTrend ?? []).map((point) => point.seconds)
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
        openFailures={openDeadLetters.length}
        onOpenQueue={() => props.onOpenTab('runs')}
      />

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

      <ValueDashboardSection
        mttrMs={metrics?.mttr.value ?? null}
        mttrDisplay={metrics?.mttr.display ?? '—'}
        clustersResolved={metrics?.clustersResolved}
        valueEstimate={metrics?.valueEstimate}
        windowDays={metrics?.windowDays ?? 30}
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
