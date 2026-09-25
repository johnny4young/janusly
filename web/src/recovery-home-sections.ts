/**
 * Recovery Center section readers. Each checks its section with the generated
 * component guard, so a malformed section degrades alone like an unavailable one.
 */

import type * as Api from './lib/api-types.generated'
import { isFailureClusters } from './lib/api-guards/components/FailureClusters'
import { isRecoveryHeatmap } from './lib/api-guards/components/RecoveryHeatmap'
import { isRecoveryHomeCases } from './lib/api-guards/components/RecoveryHomeCases'
import { isRecoveryHomeQueue } from './lib/api-guards/components/RecoveryHomeQueue'
import { isRecoveryLedger } from './lib/api-guards/components/RecoveryLedger'
import { isRecoveryMetrics } from './lib/api-guards/components/RecoveryMetrics'
import { isRecoveryValidationReport } from './lib/api-guards/components/RecoveryValidationReport'
import { isRecoveryWins } from './lib/api-guards/components/RecoveryWins'
import type { RecoveryValidationReport } from './components/RecoveryValidationSection'
import type {
  ClusterCategory,
  ClusterOwner,
  ClustersResponse,
  HeatmapDay,
  OperatorWins,
  RecoveryLedger,
  RecoveryMetrics,
} from './components/recovery-center/recovery-center-model'

export type RecoveryHomeQueueSection = {
  counts: { open: number }
  oldestOpen: { createdAt?: string } | null
}

export type RecoveryHomeCase = Api.RecoveryHomeCases['cases'][number]

export function decodeRecoveryMetrics(value: unknown): RecoveryMetrics | null {
  if (!isRecoveryMetrics(value)) return null
  // The verified-recovery tile formats p50/p90 as durations of this one metric.
  const verified = value.verifiedRecovery
  if (verified.definitionVersion !== '1' || verified.metric !== 'time_to_verified_recovery'
    || verified.unit !== 'milliseconds') return null
  return value as RecoveryMetrics
}

// The cluster tiles translate category and owner; an unknown value has no copy.
const CLUSTER_CATEGORIES: ReadonlySet<string> = new Set<ClusterCategory>([
  'secret_missing', 'http_error', 'network_timeout', 'ai_provider', 'parse_error', 'tool_input', 'unknown',
])
const CLUSTER_OWNERS: ReadonlySet<string> = new Set<ClusterOwner>(['ops', 'workflow_author', 'platform'])

export function decodeClustersResponse(value: unknown): ClustersResponse | null {
  if (!isFailureClusters(value) || !value.clusters.every(cluster => (
    CLUSTER_CATEGORIES.has(cluster.category) && CLUSTER_OWNERS.has(cluster.suggestedOwner)
  ))) return null
  return value as ClustersResponse
}

export function decodeHeatmap(value: unknown): { days: HeatmapDay[] } | null {
  return isRecoveryHeatmap(value) ? { days: value.days } : null
}

export function decodeRecoveryValidationReport(value: unknown): RecoveryValidationReport | null {
  return isRecoveryValidationReport(value) ? value as RecoveryValidationReport : null
}

export function decodeRecoveryCases(value: unknown): { cases: RecoveryHomeCase[] } | null {
  return isRecoveryHomeCases(value) ? { cases: value.cases } : null
}

export function decodeRecoveryLedger(value: unknown): RecoveryLedger | null {
  return isRecoveryLedger(value) ? value : null
}

export function decodeOperatorWins(value: unknown): OperatorWins | null {
  return isRecoveryWins(value) ? value : null
}

export function decodeRecoveryQueue(value: unknown): RecoveryHomeQueueSection | null {
  if (!isRecoveryHomeQueue(value)) return null
  return {
    counts: { open: value.counts.open },
    oldestOpen: value.oldestOpen === null ? null : { createdAt: value.oldestOpen.createdAt ?? undefined },
  }
}
