import { AlertTriangle, Users } from 'lucide-react'
import { useT } from '../../i18n'
import type { ActiveTab } from '../../types'
import { RecoveryValidationSection, type RecoveryValidationReport } from '../RecoveryValidationSection'
import { ValueDashboardSection } from '../ValueDashboardSection'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from '../VitalSignsStrip'
import { requestRecoveryDayFocus } from '../recovery-day-focus-bus'
import { selectRecoveryTimeMetric } from '../recovery-metrics'
import { RecoveryCenterComposer } from './RecoveryCenterComposer'
import {
  BudgetTile,
  CalibrationHealthTile,
  FailureClustersTile,
  OperatorTodayTile,
} from './RecoveryCenterTiles'
import { RecoveryHeatmap } from './RecoveryHeatmap'
import { useRecoveryKpiTiles } from './recovery-kpi-tiles'
import {
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
  recentDlqRunId,
  onOpenTab,
  onOpenRecoveryQueue,
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
  recentDlqRunId: string | undefined
  onOpenTab: (tab: ActiveTab) => void
  onOpenRecoveryQueue: (deadLetterId?: string) => void
}) {
  const { t } = useT()
  const failuresLabel = t('recoveryCenter.metric.failures.label')
  const failuresDisplay = String(openFailureCount)
  const failuresRationale = openFailureCount === 0
    ? t('recoveryCenter.metric.failures.rationaleEmpty')
    : t('recoveryCenter.metric.failures.rationale')
  const recoveryTime = metrics ? selectRecoveryTimeMetric(metrics) : null
  const openDay = (day: string) => {
    requestRecoveryDayFocus(day)
    onOpenTab('recover')
  }
  const kpis = useRecoveryKpiTiles(metrics, onOpenTab, openDay)
  const approvalsLabel = t('recoveryCenter.metric.approvals.label')
  const approvalsDisplay = String(waitingApprovals)
  const approvalsRationale = waitingApprovals === 0
    ? t('recoveryCenter.metric.approvals.rationaleEmpty')
    : t('recoveryCenter.metric.approvals.rationale')
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
    kpis.verifiedRecovery,
    kpis.firstAction,
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
    kpis.replay,
    kpis.durability,
    kpis.sla,
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
        onSelectDay={openDay}
      />

      <div className="we-home-insights__grid">
        <section className="we-home-insights__assistant">
          <RecoveryCenterComposer
            onOpenTab={onOpenTab}
            recentDlqRunId={recentDlqRunId}
          />
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
