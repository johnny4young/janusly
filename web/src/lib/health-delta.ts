import type { ApiResponses } from './api-types.generated'
import { isGetWorkflowsHealthDeltaResponse } from './api-guards/operations/GetWorkflowsHealthDelta'

export type HealthSnapshot = {
  score: number
  status: string
  signals: { p95LatencyMs: number | null; totalRuns: number; totalCostUsd: number }
}

export type RecoveryDelta = ApiResponses['GET /workflows/health/delta']

/**
 * Shape is the generated guard's; sample floors, sample caps, score ranges and
 * window bounds are server policy. The rules below are what RecoveryDeltaCard
 * renders from.
 */
export function isRecoveryDelta(value: unknown, workflowId: string, afterVersion: number, signature: string | null): value is RecoveryDelta {
  if (!isGetWorkflowsHealthDeltaResponse(value)) return false
  // The card labels every number with the workflow version it asked about.
  if (value.workflowId !== workflowId || value.afterVersion !== afterVersion) return false
  const runs = value.recentRunsAgainstAfter
  // The run sentence splits the total into succeeded, failed and running.
  if (runs.succeeded + runs.failed + runs.running > runs.totalRuns) return false
  // The delta pills render exactly when the server says there is enough data.
  if (value.hasEnoughData !== (value.delta !== null)) return false
  // Rollback offers the prior version as an older target than the applied one.
  if (value.priorVersion && value.priorVersion.version >= afterVersion) return false
  const failure = value.sameFailureSinceApply
  // Recurrence evidence must be about the failure this recovery fixed, with distinct sample links.
  return failure === null || (!!signature && failure.priorSignature === signature
    && failure.sampleDeadLetterIds.length <= failure.count
    && new Set(failure.sampleDeadLetterIds).size === failure.sampleDeadLetterIds.length)
}
