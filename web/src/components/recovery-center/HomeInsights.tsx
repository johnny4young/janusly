import {
  AlertTriangle,
  Hourglass,
  RefreshCw,
  ShieldCheck,
  Target,
  Users,
  Zap,
} from 'lucide-react'
import { tRecoveryMetricRationale, useT } from '../../i18n'
import type { ActiveTab } from '../../types'
import { RecoveryValidationSection, type RecoveryValidationReport } from '../RecoveryValidationSection'
import { ValueDashboardSection } from '../ValueDashboardSection'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from '../VitalSignsStrip'
import { requestRecoveryDayFocus } from '../recovery-day-focus-bus'
import { selectRecoveryTimeMetric } from '../recovery-metrics'
import { RecoveryCenterComposer } from './RecoveryCenterComposer'
import { RecoveryLabEntry } from './RecoveryCenterEmptyState'
import {
  BudgetTile,
  CalibrationHealthTile,
  FailureClustersTile,
  OperatorTodayTile,
} from './RecoveryCenterTiles'
import { RecoveryHeatmap } from './RecoveryHeatmap'
import {
  formatDowntime,
  type ClustersResponse,
  type HeatmapCell,
  type HeatmapDay,
  type OperatorWins,
  type RecoveryLedger,
  type RecoveryMetrics,
} from './recovery-center-model'

export function HomeInsights({
  metrics,
  openFailureCount,
  waitingApprovals,
  clusters,
  heatmap,
  heatmapCells,
  nowMs,
  validation,
  ledger,
  personalWins,
  showRecoveryLab,
  recentDlqRunId,
  onOpenTab,
  onOpenRecoveryQueue,
  onStartRecoveryDrill,
  onDismissRecoveryLab,
}: {
  metrics: RecoveryMetrics | null
  openFailureCount: number
  waitingApprovals: number
  clusters: ClustersResponse | null
  heatmap: HeatmapDay[]
  heatmapCells: HeatmapCell[]
  nowMs: number | null
  validation: RecoveryValidationReport | null | undefined
  ledger: RecoveryLedger | null
  personalWins: OperatorWins | null
  showRecoveryLab: boolean
  recentDlqRunId: string | undefined
  onOpenTab: (tab: ActiveTab) => void
  onOpenRecoveryQueue: (deadLetterId?: string) => void
  onStartRecoveryDrill: (() => void | Promise<void>) | undefined
  onDismissRecoveryLab: () => void
}) {
  const { t } = useT()
  const failuresLabel = t('recoveryCenter.metric.failures.label')
  const failuresDisplay = String(openFailureCount)
  const failuresRationale = openFailureCount === 0
    ? t('recoveryCenter.metric.failures.rationaleEmpty')
    : t('recoveryCenter.metric.failures.rationale')
  const recoveryTime = metrics ? selectRecoveryTimeMetric(metrics) : null
  const recoveryTimeLabel = t('recoveryCenter.metric.mttr.label')
  const recoveryTimeDisplay = recoveryTime?.display ?? '—'
  const recoveryTimeRationale = recoveryTime
    ? tRecoveryMetricRationale(recoveryTime)
    : t('recoveryCenter.metric.mttr.rationaleFallback')
  const mttrTrend = metrics?.mttrTrend ?? []
  const mttrTrendSeconds = mttrTrend.map((point) => point.seconds)
  const mttrTrendPointLabels = mttrTrend.map(
    (point) => `${point.day}: ${formatDowntime(point.seconds * 1000)}`,
  )
  const mttrTrendTitle = mttrTrendPointLabels.join('\n')
  const firstActionLabel = t('recoveryCenter.metric.firstAction.label')
  const firstActionDisplay = metrics?.timeToFirstAction?.display ?? '—'
  const firstActionRationale = metrics?.timeToFirstAction
    ? tRecoveryMetricRationale(metrics.timeToFirstAction)
    : t('recoveryCenter.metric.firstAction.rationaleFallback')
  const approvalsLabel = t('recoveryCenter.metric.approvals.label')
  const approvalsDisplay = String(waitingApprovals)
  const approvalsRationale = waitingApprovals === 0
    ? t('recoveryCenter.metric.approvals.rationaleEmpty')
    : t('recoveryCenter.metric.approvals.rationale')
  const replayLabel = t('recoveryCenter.metric.replay.label')
  const replayDisplay = metrics?.replayRate.display ?? '—'
  const replayRationale = metrics?.replayRate
    ? tRecoveryMetricRationale(metrics.replayRate)
    : t('recoveryCenter.metric.replay.rationaleFallback')
  const durabilityLabel = t('recoveryCenter.metric.durability.label')
  const durabilityDisplay = metrics?.recurrenceRate?.display ?? '—'
  const durabilityRationale = metrics?.recurrenceRate
    ? tRecoveryMetricRationale(metrics.recurrenceRate)
    : t('recoveryCenter.metric.durability.rationaleFallback')
  const slaLabel = t('recoveryCenter.metric.sla.label')
  const slaDisplay = metrics?.slaAttainment?.display ?? '—'
  const slaRationale = metrics?.slaAttainment
    ? tRecoveryMetricRationale(metrics.slaAttainment)
    : t('recoveryCenter.metric.sla.rationaleFallback')
  const homeTiles: VitalSignsTile[] = [
    {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      label: failuresLabel,
      display: failuresDisplay,
      numericValue: openFailureCount,
      severity: openFailureCount === 0 ? 'healthy' : openFailureCount > 5 ? 'unhealthy' : 'warn',
      rationale: failuresRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: failuresLabel,
        display: failuresDisplay,
        rationale: failuresRationale,
      }),
      onClick: () => onOpenRecoveryQueue(),
      testId: 'recovery-center-metric-failures',
    },
    {
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
      sparklineLabel: t('recoveryCenter.metric.mttr.trendAria', {
        count: mttrTrendSeconds.length,
      }),
      sparklineTitle: mttrTrendSeconds.length >= 2 ? mttrTrendTitle : undefined,
      sparklinePointLabels: mttrTrendSeconds.length >= 2
        ? mttrTrendPointLabels
        : undefined,
      onSelectSparklinePoint: mttrTrendSeconds.length >= 2
        ? (index) => {
            const day = mttrTrend[index]?.day
            if (!day) return
            requestRecoveryDayFocus(day)
            onOpenTab('recover')
          }
        : undefined,
      onClick: () => onOpenTab('operations'),
      testId: 'recovery-center-metric-verified-recovery',
    },
    {
      icon: <Hourglass size={14} aria-hidden="true" />,
      label: firstActionLabel,
      display: firstActionDisplay,
      numericValue: metrics?.timeToFirstAction?.value ?? null,
      severity: metrics?.timeToFirstAction?.severity ?? 'neutral',
      rationale: firstActionRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: firstActionLabel,
        display: firstActionDisplay,
        rationale: firstActionRationale,
      }),
      onClick: () => onOpenTab('operations'),
      testId: 'recovery-center-metric-first-action',
    },
    {
      icon: <Users size={14} aria-hidden="true" />,
      label: approvalsLabel,
      display: approvalsDisplay,
      numericValue: waitingApprovals,
      severity: waitingApprovals === 0 ? 'healthy' : 'warn',
      rationale: approvalsRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: approvalsLabel,
        display: approvalsDisplay,
        rationale: approvalsRationale,
      }),
      onClick: () => onOpenTab('runs'),
      testId: 'recovery-center-metric-approvals',
    },
    {
      icon: <Zap size={14} aria-hidden="true" />,
      label: replayLabel,
      display: replayDisplay,
      numericValue: metrics?.replayRate.value ?? null,
      severity: metrics?.replayRate.severity ?? 'neutral',
      rationale: replayRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: replayLabel,
        display: replayDisplay,
        rationale: replayRationale,
      }),
      onClick: () => onOpenTab('operations'),
      testId: 'recovery-center-metric-replay',
    },
    {
      icon: <ShieldCheck size={14} aria-hidden="true" />,
      label: durabilityLabel,
      display: durabilityDisplay,
      numericValue: metrics?.recurrenceRate?.value ?? null,
      progressValue: metrics?.recurrenceRate?.value ?? null,
      severity: metrics?.recurrenceRate?.severity ?? 'neutral',
      rationale: durabilityRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: durabilityLabel,
        display: durabilityDisplay,
        rationale: durabilityRationale,
      }),
      onClick: () => onOpenTab('operations'),
      testId: 'recovery-center-metric-durability',
    },
    {
      icon: <Target size={14} aria-hidden="true" />,
      label: slaLabel,
      display: slaDisplay,
      numericValue: metrics?.slaAttainment?.value ?? null,
      severity: metrics?.slaAttainment?.severity ?? 'neutral',
      rationale: slaRationale,
      ariaLabel: t('recoveryCenter.metric.aria', {
        label: slaLabel,
        display: slaDisplay,
        rationale: slaRationale,
      }),
      onClick: () => onOpenTab('operations'),
      testId: 'recovery-center-metric-sla',
    },
  ]
  const topClusters = (clusters?.clusters ?? [])
    .slice()
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 3)

  return (
    <div className="we-home-insights__content" data-testid="home-insights-content">
      <VitalSignsStrip
        tiles={withSeverityLabels(homeTiles, t)}
        ariaLabel={t('recoveryCenter.metricStripAria')}
        testId="recovery-center-metric-strip"
      />

      <RecoveryHeatmap
        days={heatmap}
        cells={heatmapCells}
        windowDays={90}
        nowMs={nowMs}
        onSelectDay={(day) => {
          requestRecoveryDayFocus(day)
          onOpenTab('recover')
        }}
      />

      <div className="we-home-insights__grid">
        <section className="we-home-insights__assistant">
          <RecoveryCenterComposer
            onOpenTab={onOpenTab}
            recentDlqRunId={recentDlqRunId}
          />
          {showRecoveryLab && (
            <RecoveryLabEntry
              onOpenStudio={() => onOpenTab('ai-studio')}
              onOpenRecipes={() => onOpenTab('templates')}
              onStartDrill={onStartRecoveryDrill}
              onDismiss={onDismissRecoveryLab}
            />
          )}
        </section>
        <aside className="we-home-insights__rail" aria-label={t('recoveryCenter.railAria')}>
          <FailureClustersTile
            clusters={topClusters}
            totalSamples={clusters?.totalSamples ?? 0}
            onOpenTab={onOpenTab}
          />
          <CalibrationHealthTile />
          <OperatorTodayTile
            metrics={metrics}
            openDeadLetters={openFailureCount}
            waitingNodes={waitingApprovals}
            onOpenTab={onOpenTab}
          />
          <BudgetTile onOpenTab={onOpenTab} />
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
        personalWins={personalWins}
        terminalRunsZero={(metrics?.terminalRuns ?? 0) === 0}
      />
    </div>
  )
}
