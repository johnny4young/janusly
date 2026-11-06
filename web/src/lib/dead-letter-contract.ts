import { api, contractApi } from '../api'
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

type ClusterMembers = { deadLetterIds: string[]; total: number; capped: boolean }

/** The open members of a failure signature, under the same 100-row cap as the apply route. */
export async function readClusterMembers(signature: string): Promise<ClusterMembers> {
  return await api(`/dlq/cluster-members?signature=${encodeURIComponent(signature)}`) as ClusterMembers
}

export type ClusterRecovery = { dlq: DeadLetterDetail; members: string[]; capped: boolean; total: number }

/**
 * Members plus the row whose snapshot validates a patch for the whole cluster.
 * The representative may have been replayed or closed since the caller read it,
 * so it falls back to the first open member. Null when no member is open.
 */
export async function readClusterRecovery(signature: string, representativeId: string): Promise<ClusterRecovery | null> {
  const [members, representative] = await Promise.all([
    readClusterMembers(signature),
    readDeadLetterDetail(representativeId),
  ])
  let dlq = representative
  if (!members.deadLetterIds.includes(representativeId)) {
    const fallback = members.deadLetterIds[0]
    if (!fallback) return null
    dlq = await readDeadLetterDetail(fallback)
  }
  return { dlq, members: members.deadLetterIds, capped: members.capped, total: members.total }
}

/** Resolves only on the server's affirmative `{ ok: true }` receipt, which the guard requires. */
export async function resolveDeadLetterEntry(id: string, reason: string): Promise<void> {
  await contractApi('POST /dlq/resolve', '/dlq/resolve', { id, reason }, { guard: isPostDlqResolveResponse })
}
