/**
 * Recovery Center section readers. `GET /recovery/home` reaches them through
 * its generated guard in contractApi, so section values already have the
 * manifest shape; these keep only the projections and the invariants the
 * Recovery Center renders from. An absent or unavailable section is handled
 * by `readRecoveryHomeSection` before any reader runs.
 */

import type { ApiResponses } from './lib/api-types.generated'
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

type Sections = ApiResponses['GET /recovery/home']['sections']
type Section<K extends keyof Sections> = Extract<NonNullable<Sections[K]>, { status: 'ok' }>['value']

export type RecoveryHomeQueueSection = {
  counts: { open: number }
  oldestOpen: { createdAt?: string } | null
}

export type RecoveryHomeCase = Section<'cases'>['cases'][number]

export function decodeRecoveryMetrics(value: unknown): RecoveryMetrics | null {
  const metrics = value as Section<'metrics'>
  // The verified-recovery tile formats p50/p90 as durations of this one metric.
  const verified: Partial<Section<'metrics'>['verifiedRecovery']> | undefined = metrics.verifiedRecovery
  if (verified && (verified.definitionVersion !== '1' || verified.metric !== 'time_to_verified_recovery'
    || verified.unit !== 'milliseconds')) return null
  return metrics as RecoveryMetrics
}

// The cluster tiles translate category and owner; an unknown value has no copy.
const CLUSTER_CATEGORIES: ReadonlySet<string> = new Set<ClusterCategory>([
  'secret_missing', 'http_error', 'network_timeout', 'ai_provider', 'parse_error', 'tool_input', 'unknown',
])
const CLUSTER_OWNERS: ReadonlySet<string> = new Set<ClusterOwner>(['ops', 'workflow_author', 'platform'])

export function decodeClustersResponse(value: unknown): ClustersResponse | null {
  const clusters = value as Section<'clusters'>
  if (!clusters.clusters.every(cluster => (
    CLUSTER_CATEGORIES.has(cluster.category) && CLUSTER_OWNERS.has(cluster.suggestedOwner)
  ))) return null
  return clusters as ClustersResponse
}

export function decodeHeatmap(value: unknown): { days: HeatmapDay[] } | null {
  return { days: (value as Section<'heatmap'>).days }
}

export function decodeRecoveryValidationReport(value: unknown): RecoveryValidationReport | null {
  return value as Section<'validation'> as RecoveryValidationReport
}

export function decodeRecoveryCases(value: unknown): { cases: RecoveryHomeCase[] } | null {
  return { cases: (value as Section<'cases'>).cases }
}

export function decodeRecoveryLedger(value: unknown): RecoveryLedger | null {
  return value as Section<'ledger'> as RecoveryLedger
}

export function decodeOperatorWins(value: unknown): OperatorWins | null {
  return value as Section<'wins'> as OperatorWins
}

export function decodeRecoveryQueue(value: unknown): RecoveryHomeQueueSection | null {
  const queue = value as Section<'queue'>
  return {
    counts: { open: queue.counts.open },
    oldestOpen: queue.oldestOpen === null ? null : { createdAt: queue.oldestOpen.createdAt ?? undefined },
  }
}
