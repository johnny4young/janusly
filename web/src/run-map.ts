/**
 * Pure projections of the run map read model (`GET /v1/runs/{runId}/map`)
 * for the canvas node overlay and the Agents tab lanes.
 *
 * Invariants:
 * - Node status stays with the live run projection; the map adds time, cost,
 *   stuck and "needs you".
 * - A decision is offered only while the live node still waits and its
 *   binding (approval id and digest, or form token) is complete.
 */

import { isTerminalRunStatus } from '@/lib/status'
import type { ApiResponse } from './lib/api-types.generated'
import { getToolApprovalRequest, readHumanFormWaiting } from './run-observability'
import type { RunNode, RunSummary } from './types'

export type RunMap = ApiResponse<'GET /runs/{runId}/map'>
export type RunMapLane = RunMap['lanes'][number]
export type RunMapLaneStep = RunMapLane['steps'][number]
export type RunMapSnapshot = { runId: string; map: RunMap; receivedAt: number }

export type RunMapDecision =
  | { kind: 'tool_approval'; approvalId: string; paramsDigest: string }
  | { kind: 'approval' }
  | { kind: 'human_form'; resumeToken: string }

export type RunMapNodeOverlay = {
  attempts: number
  elapsedMs: number | null
  /** Set while the step has not finished: elapsed keeps counting from here. */
  liveSince: number | null
  costUsd: number
  tokens: number
  stuck: boolean
  needsYou: boolean
  childRunId: string | null
  decision: RunMapDecision | null
  rerun: boolean
}

const RERUN_EXCLUDED = new Set(['pending', 'queued', 'running', 'waiting', 'skipped'])

function decisionFor(node: RunNode | undefined): RunMapDecision | null {
  if (node?.status !== 'waiting') return null
  const toolApproval = getToolApprovalRequest(node)
  if (toolApproval) return { kind: 'tool_approval', approvalId: toolApproval.approvalId, paramsDigest: toolApproval.paramsDigest }
  const form = readHumanFormWaiting(node)
  if (form) return { kind: 'human_form', resumeToken: form.resumeToken }
  const waiting = node.stateJson?.waiting
  const kind = waiting && typeof waiting === 'object' && !Array.isArray(waiting) ? (waiting as { kind?: unknown }).kind : undefined
  return kind === 'approval' ? { kind: 'approval' } : null
}

/** Per-node overlay keyed by node id. */
export function projectRunMapOverlays(
  snapshot: RunMapSnapshot | null,
  runNodes: readonly RunNode[],
  run: Pick<RunSummary, 'status' | 'replayMode'>,
  canStartRuns: boolean,
): ReadonlyMap<string, RunMapNodeOverlay> {
  const overlays = new Map<string, RunMapNodeOverlay>()
  if (!snapshot) return overlays
  const live = new Map(runNodes.map(node => [node.nodeId, node]))
  const runFinished = isTerminalRunStatus(run.status) || isTerminalRunStatus(snapshot.map.run.status)
  const canRerun = canStartRuns && !run.replayMode && isTerminalRunStatus(run.status)
  for (const node of snapshot.map.nodes) {
    const current = live.get(node.nodeId)
    const status = current?.status ?? node.status
    const decision = node.needsYou ? decisionFor(current) : null
    overlays.set(node.nodeId, {
      attempts: node.attempts,
      elapsedMs: node.elapsedMs,
      liveSince: !runFinished && node.startedAt && !node.finishedAt && node.elapsedMs !== null ? snapshot.receivedAt : null,
      costUsd: node.costUsd,
      tokens: node.tokens,
      stuck: node.stuck && status === 'running',
      needsYou: node.needsYou && status === 'waiting',
      childRunId: node.childRunId,
      decision,
      rerun: canRerun && !RERUN_EXCLUDED.has(status),
    })
  }
  return overlays
}

export function liveElapsedMs(overlay: Pick<RunMapNodeOverlay, 'elapsedMs' | 'liveSince'>, now: number): number | null {
  if (overlay.elapsedMs === null) return null
  return overlay.liveSince === null ? overlay.elapsedMs : overlay.elapsedMs + Math.max(0, now - overlay.liveSince)
}

export function formatRunCost(usd: number, locale: string): string {
  // Two significant digits for cents-scale costs, never fewer than whole cents.
  return usd.toLocaleString(locale, {
    style: 'currency', currency: 'USD', maximumSignificantDigits: 2, maximumFractionDigits: 2, roundingPriority: 'morePrecision',
  })
}

export function formatTokenCount(tokens: number, locale: string): string {
  return tokens.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 1 })
}

export type LaneStepLabel = { key: string; params: Record<string, string | number> }
export type LaneStepView = { key: string; step: RunMapLaneStep; label: LaneStepLabel; tone: 'tool' | 'success' | 'error' | 'info' }
export type LaneTrack = { agent: string | null; steps: LaneStepView[] }
export type AgentLaneView = { nodeId: string; kind: string; stepCount: number; truncated: boolean; tracks: LaneTrack[] }

// The crew emits both `multi_agent.agent.started` and its inner loop's
// `multi_agent.agent.<n>.started`; keep one.
const INNER_LIFECYCLE = /^multi_agent\.agent\.\d+\.(started|completed)$/

// Crew lifecycle events name their agent as `name`.
const laneAgent = (step: RunMapLaneStep) => step.agent ?? step.name

/** Catalog key and params for one lane step; the caller translates. */
export function laneStepLabel(step: RunMapLaneStep): LaneStepLabel {
  const type = step.type
  const tool = step.tool ?? ''
  const name = laneAgent(step) ?? ''
  if (type === 'multi_agent.started') return { key: 'runWorkspace.lanes.step.teamStarted', params: {} }
  if (type === 'multi_agent.completed') return { key: 'multiAgent.teamCompleted', params: {} }
  if (type === 'multi_agent.agent.started') return { key: 'multiAgent.agentStarted', params: { name } }
  if (type === 'multi_agent.agent.completed') return { key: 'multiAgent.agentCompleted', params: { name } }
  if (type === 'multi_agent.agent.failed') return { key: 'runWorkspace.lanes.step.agentFailed', params: { name } }
  if (type === 'agent.memory.recalled') return { key: 'runWorkspace.lanes.step.memory', params: {} }
  if (type === 'agent.reasoning') return { key: 'runWorkspace.lanes.step.reasoning', params: {} }
  if (type.endsWith('.step.started')) return { key: 'multiAgent.stepStarted', params: { step: (step.iteration ?? 0) + 1 } }
  if (type.endsWith('.step.planned')) return tool ? { key: 'multiAgent.stepPlanned', params: { tool } } : { key: 'runWorkspace.lanes.step.planned', params: {} }
  if (type.endsWith('.tool.started')) return tool ? { key: 'multiAgent.toolStarted', params: { tool } } : { key: 'multiAgent.legend.tool', params: {} }
  if (type.endsWith('.tool.completed')) return tool ? { key: 'runWorkspace.lanes.step.toolCompleted', params: { tool } } : { key: 'multiAgent.toolCompleted', params: {} }
  if (type.endsWith('.reflection')) return { key: 'runWorkspace.lanes.step.reflection', params: {} }
  if (type.endsWith('.failed')) return { key: 'runWorkspace.lanes.step.failed', params: {} }
  if (type.endsWith('.completed')) return { key: 'runWorkspace.lanes.step.completed', params: {} }
  if (type.endsWith('.started')) return { key: 'runWorkspace.lanes.step.started', params: {} }
  return { key: 'runWorkspace.lanes.step.other', params: { type } }
}

function laneTone(step: RunMapLaneStep): LaneStepView['tone'] {
  if (step.type.endsWith('.failed') || step.status === 'failed') return 'error'
  if (step.type.includes('.tool.')) return 'tool'
  if (step.type.endsWith('.completed')) return 'success'
  return 'info'
}

/** Lanes for the Agents tab: one per agent step, crews split into one track per agent. */
export function projectAgentLanes(lanes: readonly RunMapLane[]): AgentLaneView[] {
  return lanes.map((lane) => {
    const tracks = new Map<string | null, LaneStepView[]>()
    let stepCount = 0
    lane.steps.forEach((step, index) => {
      if (INNER_LIFECYCLE.test(step.type)) return
      // Crew agents also emit unprefixed `agent.*` steps (reasoning) under their name.
      const perAgent = step.type.startsWith('multi_agent.agent') || step.type.startsWith('agent.')
      const agent = lane.kind === 'multi_agent' && perAgent ? laneAgent(step) ?? null : null
      const track = tracks.get(agent) ?? []
      track.push({ key: `${index}:${step.type}`, step, label: laneStepLabel(step), tone: laneTone(step) })
      tracks.set(agent, track)
      stepCount += 1
    })
    return {
      nodeId: lane.nodeId,
      kind: lane.kind,
      stepCount,
      truncated: lane.truncated,
      tracks: [...tracks].map(([agent, steps]) => ({ agent, steps })),
    }
  })
}
