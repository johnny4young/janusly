/** Observed external agent sessions (`/v1/agent-sessions`). */
import { contractApi } from '../api'
import { isGetAgentSessionsResponse } from './api-guards/operations/GetAgentSessions'
import { isGetAgentSessionsSessionIdMapResponse } from './api-guards/operations/GetAgentSessionsSessionIdMap'
import { isPostAgentSessionsSessionIdDraftResponse } from './api-guards/operations/PostAgentSessionsSessionIdDraft'
import { isPostAgentSessionsGatesGateIdDecideResponse } from './api-guards/operations/PostAgentSessionsGatesGateIdDecide'
import type { ApiResponse } from './api-types.generated'

export type AgentSessionPage = ApiResponse<'GET /agent-sessions'>
export type AgentSessionSummary = AgentSessionPage['sessions'][number]
export type AgentSessionMap = ApiResponse<'GET /agent-sessions/{sessionId}/map'>

export function listAgentSessions(cursor: string | null, signal?: AbortSignal): Promise<AgentSessionPage> {
  const path = cursor ? `/v1/agent-sessions?cursor=${encodeURIComponent(cursor)}` : '/v1/agent-sessions'
  return contractApi('GET /agent-sessions', path, undefined, { signal, guard: isGetAgentSessionsResponse })
}

export function getAgentSessionMap(id: string, signal?: AbortSignal): Promise<AgentSessionMap> {
  return contractApi('GET /agent-sessions/{sessionId}/map', `/v1/agent-sessions/${encodeURIComponent(id)}/map`, undefined, {
    signal, guard: isGetAgentSessionsSessionIdMapResponse,
  })
}

export type AgentSessionGate = AgentSessionMap['gates'][number]

export function decideAgentGate(id: string, decision: 'approve' | 'deny') {
  return contractApi('POST /agent-sessions/gates/{gateId}/decide', `/v1/agent-sessions/gates/${encodeURIComponent(id)}/decide`,
    { decision }, { guard: isPostAgentSessionsGatesGateIdDecideResponse })
}

export type AgentSessionDraft = ApiResponse<'POST /agent-sessions/{sessionId}/draft'>

export function saveAgentSessionAsDraft(id: string): Promise<AgentSessionDraft> {
  return contractApi('POST /agent-sessions/{sessionId}/draft', `/v1/agent-sessions/${encodeURIComponent(id)}/draft`, undefined, {
    guard: isPostAgentSessionsSessionIdDraftResponse,
  })
}

export function runtimeLabel(runtime: string): string {
  return runtime === 'claude-code' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime
}
