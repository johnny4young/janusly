import { contractApi } from '../api'
import { t } from '../i18n/runtime'
import type { ApiResponses } from './api-types.generated'
import {
  isRecord,
  isNonEmptyString as nonempty,
  isNonNegativeSafeInteger as count,
  isNullableString as nullableText,
} from './guards'
import { isGetDlqEntriesDeadLetterIdResponse, isPostDlqResolveResponse } from './api-guards.generated'

export type DeadLetterDetail = ApiResponses['GET /dlq/entries/{deadLetterId}']
type Drill = NonNullable<DeadLetterDetail['drill']>
type Outcome = NonNullable<DeadLetterDetail['drillOutcome']>

const oneOf = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value)

function isDrill(value: unknown): value is Drill {
  return isRecord(value) && value.kind === 'solution_pack_drill'
    && [value.packId, value.fixtureId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 128)
    && oneOf(value.recoveryPath, ['direct_failure', 'runtime_failure', 'stalled_node_reaper'])
}

function isOutcome(value: unknown): value is Outcome {
  return isRecord(value)
    && oneOf(value.status, ['awaiting_action', 'replay_in_progress', 'recovered', 'accepted_loss', 'measurement_incomplete'])
    && nullableText(value.startedAt) && nullableText(value.completedAt)
    && (value.elapsedMs === null || count(value.elapsedMs))
    && (value.evidence === null || oneOf(value.evidence, ['terminal_impact', 'explicit_resolution']))
    && count(value.attemptCount) && typeof value.latestDeadLetterId === 'string' && typeof value.chainCapped === 'boolean'
    && isRecord(value.recurrence)
    && oneOf(value.recurrence.status, ['not_applicable', 'monitoring', 'clear', 'recurred'])
    && nullableText(value.recurrence.windowEndsAt) && nullableText(value.recurrence.recurredAt)
}

function isDetail(value: unknown, id: string): value is DeadLetterDetail {
  return isRecord(value) && value.id === id && nonempty(value.id)
    && nonempty(value.runId) && nonempty(value.nodeId) && nonempty(value.orgId)
    && count(value.attempt) && oneOf(value.status, ['open', 'replayed', 'resolved'])
    && ['workflowJson', 'nodeJson', 'errorJson'].every(key => Object.hasOwn(value, key) && value[key] !== undefined)
    && nullableText(value.createdAt) && nullableText(value.replayedAt) && nullableText(value.replayClaimedAt)
    && value.suspectVersion === null
    && (value.drill === null || isDrill(value.drill))
    && (value.drillOutcome === null || isOutcome(value.drillOutcome))
}

// Validate before treating a list row as recovery evidence. Copy the declared
// keys only: unvalidated additive fields must not replace a queue overlay.
export function parseDeadLetterDetail(value: unknown, id: string): DeadLetterDetail | null {
  if (!isDetail(value, id)) return null
  return {
    id: value.id, orgId: value.orgId, runId: value.runId, nodeId: value.nodeId,
    attempt: value.attempt, status: value.status, workflowJson: value.workflowJson,
    nodeJson: value.nodeJson, errorJson: value.errorJson, createdAt: value.createdAt,
    replayedAt: value.replayedAt, replayClaimedAt: value.replayClaimedAt,
    suspectVersion: value.suspectVersion, drill: value.drill, drillOutcome: value.drillOutcome,
  }
}

export async function readDeadLetterDetail(id: string, signal?: AbortSignal): Promise<DeadLetterDetail> {
  const payload = await contractApi('GET /dlq/entries/{deadLetterId}', `/dlq/entries/${encodeURIComponent(id)}`, undefined, { signal, guard: isGetDlqEntriesDeadLetterIdResponse })
  const detail = parseDeadLetterDetail(payload, id)
  if (!detail) throw new Error(t('api.error.malformedResponse'))
  return detail
}

export async function resolveDeadLetterEntry(id: string): Promise<void> {
  const payload: unknown = await contractApi('POST /dlq/resolve', '/dlq/resolve', { id }, { guard: isPostDlqResolveResponse })
  if (!isRecord(payload) || payload.ok !== true) throw new Error(t('api.error.malformedResponse'))
}
