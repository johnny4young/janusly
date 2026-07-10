/**
 * Shared tile builder for the Operations dashboard strip. `OperationsPage`
 * is the sole consumer; the module stays the single source of truth for the
 * Operations tile shape so a future metric change lands in one place.
 *
 * Tiles are static (no `onClick`, no `numericValue`) so the Operations
 * strip never animates and never wraps in a button — matching the legacy
 * behavior byte-for-byte.
 */

import { CheckCircle2, Clock, DollarSign, RefreshCw, Users, Zap } from 'lucide-react'
import { withSeverityLabels, type VitalSignsTile, type VitalSignsTileSeverity } from './VitalSignsStrip'
import { tRecoveryMetricRationale } from '../i18n'

/** Closed enum of metric severity values that the API echoes back. Mirrored
 *  byte-for-byte from the engine's `MetricSeverity` so the tile builder
 *  doesn't need to translate. */
export type OperationsMetricSeverity = VitalSignsTileSeverity

export type OperationsMetric = {
  value: number | null
  display: string
  severity: OperationsMetricSeverity
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

export type OperationsMetrics = {
  successRate: OperationsMetric
  mttr: OperationsMetric
  p95Latency: OperationsMetric
  approvalsPending: OperationsMetric
  replayRate: OperationsMetric
  costThisWindow: OperationsMetric & { providers: Array<unknown> }
  windowDays: number
  terminalRuns: number
}

/** Build the 6-tile Operations strip from a `RecoveryMetrics` payload.
 *  `t` is the i18n lookup from `useT()`; the strings are already-translated
 *  by the time they reach the strip. */
export function buildOperationsTiles(
  metrics: OperationsMetrics,
  t: (key: string, vars?: Record<string, unknown>) => unknown,
): VitalSignsTile[] {
  return withSeverityLabels([
    {
      icon: <CheckCircle2 size={14} aria-hidden="true" />,
      label: t('operations.metric.successRate') as string,
      display: metrics.successRate.display,
      severity: metrics.successRate.severity,
      rationale: tRecoveryMetricRationale(metrics.successRate),
      progressValue: metrics.successRate.value,
    },
    {
      icon: <RefreshCw size={14} aria-hidden="true" />,
      label: t('operations.metric.mttr') as string,
      display: metrics.mttr.display,
      severity: metrics.mttr.severity,
      rationale: tRecoveryMetricRationale(metrics.mttr),
    },
    {
      icon: <Zap size={14} aria-hidden="true" />,
      label: t('operations.metric.p95') as string,
      display: metrics.p95Latency.display,
      severity: metrics.p95Latency.severity,
      rationale: tRecoveryMetricRationale(metrics.p95Latency),
    },
    {
      icon: <Users size={14} aria-hidden="true" />,
      label: t('operations.metric.approvals') as string,
      display: metrics.approvalsPending.display,
      severity: metrics.approvalsPending.severity,
      rationale: tRecoveryMetricRationale(metrics.approvalsPending),
    },
    {
      icon: <Clock size={14} aria-hidden="true" />,
      label: t('operations.metric.replayRate') as string,
      display: metrics.replayRate.display,
      severity: metrics.replayRate.severity,
      rationale: tRecoveryMetricRationale(metrics.replayRate),
    },
    {
      icon: <DollarSign size={14} aria-hidden="true" />,
      label: t('operations.metric.cost') as string,
      display: metrics.costThisWindow.display,
      severity: metrics.costThisWindow.severity,
      rationale: tRecoveryMetricRationale(metrics.costThisWindow),
    },
  ], t)
}
