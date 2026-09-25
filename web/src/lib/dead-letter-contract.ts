import { contractApi } from '../api'
import type { ApiResponses } from './api-types.generated'
import { MalformedResponseError } from './malformed-response'
import { isGetDlqEntriesDeadLetterIdResponse } from './api-guards/operations/GetDlqEntriesDeadLetterId'
import { isPostDlqResolveResponse } from './api-guards/operations/PostDlqResolve'

export type DeadLetterDetail = ApiResponses['GET /dlq/entries/{deadLetterId}']

/**
 * Validate before treating a detail as recovery evidence. Shape is the
 * generated guard's; the recovery panels need the row they asked for, and a
 * copy of the declared keys so no additive field can replace a queue overlay.
 */
export function parseDeadLetterDetail(value: unknown, id: string): DeadLetterDetail | null {
  if (!isGetDlqEntriesDeadLetterIdResponse(value) || value.id !== id) return null
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
  if (!detail) throw new MalformedResponseError()
  return detail
}

/** Resolves only on the server's affirmative `{ ok: true }` receipt, which the guard requires. */
export async function resolveDeadLetterEntry(id: string): Promise<void> {
  await contractApi('POST /dlq/resolve', '/dlq/resolve', { id }, { guard: isPostDlqResolveResponse })
}
