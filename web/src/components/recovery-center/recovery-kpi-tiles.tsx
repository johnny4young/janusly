import { Activity, Hourglass, RefreshCw, ShieldCheck, Target, Zap } from 'lucide-react'

import { tRecoveryMetricRationale, useT } from '../../i18n'
import type { ActiveTab } from '../../types'
import { selectRecoveryTimeMetric } from '../recovery-metrics'
import type { VitalSignsTile } from '../VitalSignsStrip'
import { formatDowntime, type RecoveryMetrics } from './recovery-center-model'

/** The recovery KPI tiles Reports shows, with their drill-ins. */
export function useRecoveryKpiTiles(
  metrics: RecoveryMetrics | null,
  onOpenTab: (tab: ActiveTab) => void,
  onSelectDay: (day: string) => void,
) {
  const { t } = useT()
  const ariaLabel = (label: string, display: string, rationale: string) =>
    t('recoveryCenter.metric.aria', { label, display, rationale })

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
  const hasTrend = mttrTrendSeconds.length >= 2
  const verifiedRecovery: VitalSignsTile = {
    icon: <RefreshCw size={14} aria-hidden="true" />,
    label: recoveryTimeLabel,
    display: recoveryTimeDisplay,
    numericValue: recoveryTime?.value ?? null,
    severity: recoveryTime?.severity ?? 'neutral',
    rationale: recoveryTimeRationale,
    ariaLabel: ariaLabel(recoveryTimeLabel, recoveryTimeDisplay, recoveryTimeRationale),
    sparkline: hasTrend ? mttrTrendSeconds : undefined,
    sparklineLabel: t('recoveryCenter.metric.mttr.trendAria', { count: mttrTrendSeconds.length }),
    sparklineTitle: hasTrend ? mttrTrendPointLabels.join('\n') : undefined,
    sparklinePointLabels: hasTrend ? mttrTrendPointLabels : undefined,
    onSelectSparklinePoint: hasTrend
      ? (index) => {
          const day = mttrTrend[index]?.day
          if (day) onSelectDay(day)
        }
      : undefined,
    onClick: () => onOpenTab('operations'),
    testId: 'recovery-center-metric-verified-recovery',
  }

  const firstActionLabel = t('recoveryCenter.metric.firstAction.label')
  const firstActionDisplay = metrics?.timeToFirstAction?.display ?? '—'
  const firstActionRationale = metrics?.timeToFirstAction
    ? tRecoveryMetricRationale(metrics.timeToFirstAction)
    : t('recoveryCenter.metric.firstAction.rationaleFallback')
  const firstAction: VitalSignsTile = {
    icon: <Hourglass size={14} aria-hidden="true" />,
    label: firstActionLabel,
    display: firstActionDisplay,
    numericValue: metrics?.timeToFirstAction?.value ?? null,
    severity: metrics?.timeToFirstAction?.severity ?? 'neutral',
    rationale: firstActionRationale,
    ariaLabel: ariaLabel(firstActionLabel, firstActionDisplay, firstActionRationale),
    onClick: () => onOpenTab('operations'),
    testId: 'recovery-center-metric-first-action',
  }

  const replayLabel = t('recoveryCenter.metric.replay.label')
  const replayDisplay = metrics?.replayRate.display ?? '—'
  const replayRationale = metrics?.replayRate
    ? tRecoveryMetricRationale(metrics.replayRate)
    : t('recoveryCenter.metric.replay.rationaleFallback')
  const replay: VitalSignsTile = {
    icon: <Zap size={14} aria-hidden="true" />,
    label: replayLabel,
    display: replayDisplay,
    numericValue: metrics?.replayRate.value ?? null,
    severity: metrics?.replayRate.severity ?? 'neutral',
    rationale: replayRationale,
    ariaLabel: ariaLabel(replayLabel, replayDisplay, replayRationale),
    onClick: () => onOpenTab('operations'),
    testId: 'recovery-center-metric-replay',
  }

  const durabilityLabel = t('recoveryCenter.metric.durability.label')
  const durabilityDisplay = metrics?.recurrenceRate?.display ?? '—'
  const durabilityRationale = metrics?.recurrenceRate
    ? tRecoveryMetricRationale(metrics.recurrenceRate)
    : t('recoveryCenter.metric.durability.rationaleFallback')
  const durability: VitalSignsTile = {
    icon: <ShieldCheck size={14} aria-hidden="true" />,
    label: durabilityLabel,
    display: durabilityDisplay,
    numericValue: metrics?.recurrenceRate?.value ?? null,
    progressValue: metrics?.recurrenceRate?.value ?? null,
    severity: metrics?.recurrenceRate?.severity ?? 'neutral',
    rationale: durabilityRationale,
    ariaLabel: ariaLabel(durabilityLabel, durabilityDisplay, durabilityRationale),
    onClick: () => onOpenTab('operations'),
    testId: 'recovery-center-metric-durability',
  }

  const slaLabel = t('recoveryCenter.metric.sla.label')
  const slaDisplay = metrics?.slaAttainment?.display ?? '—'
  const slaRationale = metrics?.slaAttainment
    ? tRecoveryMetricRationale(metrics.slaAttainment)
    : t('recoveryCenter.metric.sla.rationaleFallback')
  const sla: VitalSignsTile = {
    icon: <Target size={14} aria-hidden="true" />,
    label: slaLabel,
    display: slaDisplay,
    numericValue: metrics?.slaAttainment?.value ?? null,
    severity: metrics?.slaAttainment?.severity ?? 'neutral',
    rationale: slaRationale,
    ariaLabel: ariaLabel(slaLabel, slaDisplay, slaRationale),
    onClick: () => onOpenTab('operations'),
    testId: 'recovery-center-metric-sla',
  }

  const runsLabel = t('activity.reports.runsSuccess')
  const runsDisplay = `${metrics?.terminalRuns ?? 0} · ${metrics?.successRate.display ?? '—'}`
  const runsRationale = t('activity.reports.runsWindow', { days: metrics?.windowDays ?? 30 })
  const runs: VitalSignsTile = {
    icon: <Activity size={14} aria-hidden="true" />,
    label: runsLabel,
    display: runsDisplay,
    numericValue: null,
    severity: metrics?.successRate.severity ?? 'neutral',
    rationale: runsRationale,
    ariaLabel: ariaLabel(runsLabel, runsDisplay, runsRationale),
    onClick: () => onOpenTab('runs'),
    testId: 'reports-metric-runs',
  }

  return { verifiedRecovery, firstAction, replay, durability, sla, runs }
}
