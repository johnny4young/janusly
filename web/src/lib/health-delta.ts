import { isRecord, isNonNegativeSafeInteger as count } from './guards'

export type HealthSnapshot = {
  score: number
  status: string
  signals: { p95LatencyMs: number | null; totalRuns: number; totalCostUsd: number }
}

/** Only the health-delta fields consumed by the recovery UI. */
export type RecoveryDelta = {
  workflowId: string
  afterVersion: number
  windowDays: number
  hasEnoughData: boolean
  before: HealthSnapshot
  after: HealthSnapshot
  delta: { score: number; p95LatencyMs: number | null; costPerRunUsd: number | null } | null
  recentRunsAgainstAfter: { totalRuns: number; succeeded: number; failed: number; running: number }
  sameFailureSinceApply: { count: number; sampleDeadLetterIds: string[]; priorSignature: string } | null
  priorVersion: { version: number; versionId: string } | null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256
function snapshot(value: unknown): value is HealthSnapshot {
  return isRecord(value) && count(value.score) && value.score <= 100
    && typeof value.status === 'string' && ['healthy', 'warn', 'unhealthy'].includes(value.status) && isRecord(value.signals)
    && count(value.signals.totalRuns) && finite(value.signals.totalCostUsd) && value.signals.totalCostUsd >= 0
    && (value.signals.p95LatencyMs === null || (finite(value.signals.p95LatencyMs) && value.signals.p95LatencyMs >= 0))
}

// Shape only: sample floors, sample caps and window bounds are server policy.
export function isRecoveryDelta(value: unknown, workflowId: string, afterVersion: number, signature: string | null): value is RecoveryDelta {
  if (!isRecord(value) || value.workflowId !== workflowId || value.afterVersion !== afterVersion
    || !count(afterVersion) || afterVersion < 1 || afterVersion > 2147483647
    || !count(value.windowDays) || value.windowDays < 1
    || !snapshot(value.before) || !snapshot(value.after)
    || typeof value.hasEnoughData !== 'boolean') return false
  const runs = value.recentRunsAgainstAfter
  if (!isRecord(runs) || !count(runs.totalRuns) || !count(runs.succeeded) || !count(runs.failed) || !count(runs.running)
    || runs.succeeded + runs.failed + runs.running > runs.totalRuns) return false
  const delta = value.delta
  if (value.hasEnoughData) {
    if (!isRecord(delta) || !finite(delta.score)
      || !nullableNumber(delta.p95LatencyMs) || !nullableNumber(delta.costPerRunUsd)) return false
  } else if (delta !== null) return false
  const prior = value.priorVersion
  if (prior !== null && (!isRecord(prior) || !count(prior.version) || prior.version < 1
    || prior.version >= afterVersion || !id(prior.versionId))) return false
  const failure = value.sameFailureSinceApply
  return failure === null || (isRecord(failure) && !!signature && failure.priorSignature === signature
    && count(failure.count) && Array.isArray(failure.sampleDeadLetterIds)
    && failure.sampleDeadLetterIds.length <= failure.count
    && failure.sampleDeadLetterIds.every(id) && new Set(failure.sampleDeadLetterIds).size === failure.sampleDeadLetterIds.length)
}
