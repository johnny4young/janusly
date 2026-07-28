import type { RecoveryCase } from './types'
import type { RecoveryValidationReport } from './components/RecoveryValidationSection'
import type {
  ClustersResponse,
  FailureCluster,
  HeatmapDay,
  OperatorWins,
  RecoveryLedger,
  RecoveryMetric,
  RecoveryMetrics,
} from './components/recovery-center/recovery-center-model'

export type RecoveryHomeQueueSection = {
  counts: { open: number }
  oldestOpen: { createdAt?: string } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isRecoveryMetric(value: unknown): value is RecoveryMetric {
  if (!isRecord(value)) return false
  return isNullableNumber(value.value)
    && typeof value.display === 'string'
    && ['healthy', 'warn', 'unhealthy', 'neutral'].includes(String(value.severity))
    && typeof value.rationale === 'string'
}

function optionalMetricIsValid(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || isRecoveryMetric(value[key])
}

function isValueEstimate(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.assumptions)) return false
  return isNumber(value.hoursSaved)
    && isNumber(value.dollarSaved)
    && isNullableNumber(value.mttrDeltaSeconds)
    && isNumber(value.assumptions.hourlyCost)
    && isNumber(value.assumptions.minutesSavedPerRecovery)
    && isNumber(value.assumptions.baselineMttrSeconds)
}

function isVerifiedRecoveryMetric(value: unknown): boolean {
  if (!isRecord(value)) return false
  const details = {
    definitionVersion: value.definitionVersion,
    metric: value.metric,
    unit: value.unit,
    sampleSize: value.sampleSize,
    p50Ms: value.p50Ms,
    p90Ms: value.p90Ms,
  }
  if (!isRecoveryMetric(value)) return false
  return details.definitionVersion === '1'
    && details.metric === 'time_to_verified_recovery'
    && details.unit === 'milliseconds'
    && isNumber(details.sampleSize)
    && isNullableNumber(details.p50Ms)
    && isNullableNumber(details.p90Ms)
}

export function decodeRecoveryMetrics(value: unknown): RecoveryMetrics | null {
  if (!isRecord(value)) return null
  const validRequiredMetrics = [
    'successRate',
    'mttr',
    'p95Latency',
    'approvalsPending',
    'replayRate',
  ].every((key) => isRecoveryMetric(value[key]))
  if (
    !validRequiredMetrics
    || !isNumber(value.windowDays)
    || !isNumber(value.terminalRuns)
  ) return null

  if (
    !optionalMetricIsValid(value, 'slaAttainment')
    || !optionalMetricIsValid(value, 'timeToFirstAction')
    || !optionalMetricIsValid(value, 'recurrenceRate')
  ) return null
  if (
    value.verifiedRecovery !== undefined
    && !isVerifiedRecoveryMetric(value.verifiedRecovery)
  ) return null
  if (
    value.clustersResolved !== undefined
    && (
      !isRecord(value.clustersResolved)
      || !isRecoveryMetric(value.clustersResolved)
      || !isNumber(
        (value.clustersResolved as Record<string, unknown>).totalEntries,
      )
      || typeof (value.clustersResolved as Record<string, unknown>).capped
        !== 'boolean'
    )
  ) return null
  if (
    value.valueEstimate !== undefined
    && !isValueEstimate(value.valueEstimate)
  ) return null
  if (
    value.mttrTrend !== undefined
    && (
      !Array.isArray(value.mttrTrend)
      || !value.mttrTrend.every((point) =>
        isRecord(point)
        && typeof point.day === 'string'
        && isNumber(point.seconds))
    )
  ) return null
  if (
    value.downtimeEndedMs !== undefined
    && !isNumber(value.downtimeEndedMs)
  ) return null
  return value as RecoveryMetrics
}

function isFailureCluster(value: unknown): value is FailureCluster {
  if (!isRecord(value)) return false
  return typeof value.signature === 'string'
    && [
      'secret_missing',
      'http_error',
      'network_timeout',
      'ai_provider',
      'parse_error',
      'tool_input',
      'unknown',
    ].includes(String(value.category))
    && isNumber(value.frequency)
    && ['ops', 'workflow_author', 'platform'].includes(
      String(value.suggestedOwner),
    )
    && typeof value.lastSeen === 'string'
    && (
      value.recurredAfterRecovery === undefined
      || typeof value.recurredAfterRecovery === 'boolean'
    )
}

export function decodeClustersResponse(
  value: unknown,
): ClustersResponse | null {
  if (!isRecord(value) || !Array.isArray(value.clusters)) return null
  if (
    !value.clusters.every(isFailureCluster)
    || !isNumber(value.totalSamples)
    || !isNumber(value.windowDays)
  ) return null
  return value as ClustersResponse
}

function isHeatmapDay(value: unknown): value is HeatmapDay {
  if (!isRecord(value)) return false
  return typeof value.day === 'string'
    && isNumber(value.failures)
    && isNumber(value.recovered)
    && isNumber(value.mttrSeconds)
}

export function decodeHeatmap(
  value: unknown,
): { days: HeatmapDay[] } | null {
  if (
    !isRecord(value)
    || !Array.isArray(value.days)
    || !value.days.every(isHeatmapDay)
  ) return null
  return { days: value.days }
}

function hasNumericFields(
  value: unknown,
  keys: readonly string[],
  nullableKeys: readonly string[] = [],
): boolean {
  if (!isRecord(value)) return false
  return keys.every((key) => isNumber(value[key]))
    && nullableKeys.every((key) => isNullableNumber(value[key]))
}

export function decodeRecoveryValidationReport(
  value: unknown,
): RecoveryValidationReport | null {
  if (
    !isRecord(value)
    || typeof value.generatedAt !== 'string'
    || !isNumber(value.windowDays)
    || !isNumber(value.sampleLimit)
    || typeof value.sampleCapped !== 'boolean'
    || !hasNumericFields(value.totals, [
      'drills',
      'completed',
      'recovered',
      'acceptedLoss',
      'awaitingAction',
      'replayInProgress',
      'measurementIncomplete',
      'missingEvidence',
    ], ['completionRatePercent', 'recoveryRatePercent'])
    || !hasNumericFields(value.resolution, [
      'operator',
      'automated',
      'unknown',
    ], ['operatorInterventionRatePercent'])
    || !hasNumericFields(value.timing, ['sampleSize'], [
      'medianElapsedMs',
      'p90ElapsedMs',
      'averageElapsedMs',
      'p95ElapsedMs',
    ])
    || !Array.isArray(value.byFailureMode)
    || !value.byFailureMode.every((item) =>
      isRecord(item)
      && typeof item.key === 'string'
      && hasNumericFields(item, [
        'total',
        'completed',
        'recovered',
        'acceptedLoss',
      ], ['recoveryRatePercent']))
  ) return null
  return value as RecoveryValidationReport
}

const RECOVERY_CASE_STATES = new Set([
  'detected',
  'contained',
  'diagnosed',
  'candidates_ready',
  'validating',
  'awaiting_approval',
  'publishing',
  'monitoring',
  'verified_recovered',
  'recurred',
  'accepted_loss',
  'abandoned',
])

function isRecoveryCase(value: unknown): value is RecoveryCase {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.orgId === 'string'
    && typeof value.runId === 'string'
    && isNullableString(value.workflowId)
    && typeof value.workflowVersionId === 'string'
    && value.source === 'semantic_violation'
    && typeof value.detectorId === 'string'
    && typeof value.sourceNodeId === 'string'
    && ['expression', 'schema'].includes(String(value.detectorKind))
    && ['observe', 'quarantine'].includes(String(value.action))
    && typeof value.message === 'string'
    && RECOVERY_CASE_STATES.has(String(value.state))
    && isNullableString(value.createdBy)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && isNullableString(value.resolvedAt)
}

export function decodeRecoveryCases(
  value: unknown,
): { cases: RecoveryCase[] } | null {
  if (
    !isRecord(value)
    || !Array.isArray(value.cases)
    || !value.cases.every(isRecoveryCase)
  ) return null
  return { cases: value.cases }
}

export function decodeRecoveryLedger(
  value: unknown,
): RecoveryLedger | null {
  if (!isRecord(value)) return null
  if (
    !isNumber(value.totalRecovered)
    || !isNumber(value.downtimeEndedMs)
    || !isNullableString(value.sinceIso)
  ) return null
  return value as RecoveryLedger
}

export function decodeOperatorWins(
  value: unknown,
): OperatorWins | null {
  if (
    !isRecord(value)
    || !isNumber(value.recovered)
    || !isNumber(value.windowDays)
  ) return null
  return value as OperatorWins
}

function isOldestOpenSummary(
  value: unknown,
): value is { createdAt?: string } {
  if (!isRecord(value)) return false
  return value.createdAt === undefined || typeof value.createdAt === 'string'
}

export function decodeRecoveryQueue(
  value: unknown,
): RecoveryHomeQueueSection | null {
  if (
    !isRecord(value)
    || !isRecord(value.counts)
    || !Number.isInteger(value.counts.open)
    || !isNumber(value.counts.open)
    || value.counts.open < 0
    || (
      value.oldestOpen !== null
      && !isOldestOpenSummary(value.oldestOpen)
    )
  ) return null
  return {
    counts: { open: value.counts.open },
    oldestOpen: value.oldestOpen,
  }
}
