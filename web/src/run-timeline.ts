/**
 * Pure event-order and presentation projections for the run-event timeline.
 * Kept separate from `eventUtils.ts` so multi-agent lazy chunks do not pull
 * the operator timeline into their shared dependency chunk.
 */

import {
  AGENT_REASONING_AGENT_MAX_CHARS,
  AGENT_REASONING_REASON_MAX_CHARS,
  AGENT_REASONING_SCOPE_MAX_CHARS,
  AGENT_REASONING_TOOL_MAX_CHARS,
  type AgentReasoningEventPayload,
} from '@/lib/run-events'
import { scrubOperatorGuidanceSecrets } from '@/lib/operator-guidance'

import type { RunEvent } from './types'

export type RunEventTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export type RunEventPresentation = {
  tone: RunEventTone
  noise: boolean
}

export type RunDiagnostics = {
  loadedEvents: number
  observedDurationMs: number | null
  retryCount: number
  failedNodeCount: number
  decisionCount: number
  recalledEpisodeCount: number
}

export type CausalCandidate = {
  nodeId: string
  score: number
  breakdown: {
    cost: number
    latency: number
    quality: number
    penalty: number
  }
}

export type CausalReplay = {
  chosen: CausalCandidate
  best: CausalCandidate
  ranking: CausalCandidate[]
}

const NOISE_EVENT_TYPES = new Set(['node.queued', 'run.status_checked'])

function singleLine(value: string, maxChars: number): string {
  return scrubOperatorGuidanceSecrets(value)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

/** Fail-closed browser parser for the stable cross-process event contract. */
export function parseAgentReasoning(event: RunEvent): AgentReasoningEventPayload | null {
  if (event.type !== 'agent.reasoning') return null
  const payload = record(event.payload)
  if (!payload) return null
  const { agent, iteration, planner, mode, scope, replacesEventId, decision, tool, reason } = payload
  if (
    typeof agent !== 'string'
    || !Number.isSafeInteger(iteration)
    || (iteration as number) < 0
    || (planner !== 'rules' && planner !== 'openai')
    || (mode !== 'rules' && mode !== 'ai' && mode !== 'fallback')
    || typeof scope !== 'string'
    || typeof replacesEventId !== 'string'
    || (decision !== 'finish' && decision !== 'use_tool')
    || (tool !== null && typeof tool !== 'string')
    || typeof reason !== 'string'
  ) return null
  const safeAgent = singleLine(agent, AGENT_REASONING_AGENT_MAX_CHARS)
  const safeScope = singleLine(scope, AGENT_REASONING_SCOPE_MAX_CHARS)
  const safeReplacesEventId = singleLine(replacesEventId, 160)
  const safeTool = tool === null ? null : singleLine(tool, AGENT_REASONING_TOOL_MAX_CHARS)
  const safeReason = singleLine(reason, AGENT_REASONING_REASON_MAX_CHARS)
  if (!safeAgent || !safeScope || !safeReplacesEventId || !safeReason) return null
  if ((decision === 'finish' && safeTool !== null) || (decision === 'use_tool' && !safeTool)) return null
  return {
    agent: safeAgent,
    iteration: iteration as number,
    planner,
    mode,
    scope: safeScope,
    replacesEventId: safeReplacesEventId,
    decision,
    tool: safeTool,
    reason: safeReason,
  }
}

function agentReasoningKey(event: RunEvent, payload: Pick<AgentReasoningEventPayload, 'agent' | 'iteration' | 'scope'>): string {
  return `${event.nodeId ?? ''}\u0000${payload.agent}\u0000${payload.iteration}\u0000${payload.scope}`
}

function legacyAgentPlanKey(event: RunEvent): string | null {
  const suffix = '.step.planned'
  if (!event.type.endsWith(suffix)) return null
  const payload = record(event.payload)
  if (!payload || !Number.isSafeInteger(payload.iteration) || (payload.iteration as number) < 0) return null
  const agent = typeof payload.agent === 'string'
    ? singleLine(payload.agent, AGENT_REASONING_AGENT_MAX_CHARS) || 'agent'
    : 'agent'
  const scope = singleLine(event.type.slice(0, -suffix.length), AGENT_REASONING_SCOPE_MAX_CHARS)
  if (!scope) return null
  return agentReasoningKey(event, { agent, iteration: payload.iteration as number, scope })
}

/** Hide only the exact legacy row named by a valid matching canonical event. */
export function dedupeAgentReasoningEvents(chronological: RunEvent[]): RunEvent[] {
  const replacements = new Map<string, { event: RunEvent; payload: AgentReasoningEventPayload }>()
  for (const event of chronological) {
    const canonical = parseAgentReasoning(event)
    if (canonical) replacements.set(canonical.replacesEventId, { event, payload: canonical })
  }
  return chronological.filter((event) => {
    const replacement = replacements.get(event.id)
    if (!replacement) return true
    const legacyKey = legacyAgentPlanKey(event)
    return legacyKey !== agentReasoningKey(replacement.event, replacement.payload)
  })
}

/** Classify a low-level event without hiding any of it from the operator. */
export function getRunEventPresentation(event: RunEvent): RunEventPresentation {
  const type = event.type.toLowerCase()
  if (type === 'agent.reasoning') return { tone: 'info', noise: false }
  if (type.includes('failed') || type.includes('error') || type.includes('dead_letter')) {
    return { tone: 'error', noise: false }
  }
  if (type.includes('succeeded') || type.includes('completed') || type.includes('granted') || type.includes('submitted') || type.includes('resumed')) {
    return { tone: 'success', noise: false }
  }
  if (type.includes('waiting') || type.includes('retry') || type.includes('cancelled') || type.includes('rollback.triggered')) {
    return { tone: 'warning', noise: false }
  }
  if (type === 'template.unresolved_path') return { tone: 'warning', noise: false }
  if (NOISE_EVENT_TYPES.has(type)) return { tone: 'neutral', noise: true }
  if (type.includes('started') || type.includes('running') || type.includes('decision')) {
    return { tone: 'info', noise: false }
  }
  return { tone: 'neutral', noise: false }
}

/** Chronological copy, stable for events that share or omit timestamps. */
export function sortRunEventsChronologically(events: RunEvent[]): RunEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const byTime = (a.event.createdAt ?? '').localeCompare(b.event.createdAt ?? '')
      if (byTime !== 0) return byTime
      const byId = (a.event.id ?? '').localeCompare(b.event.id ?? '')
      return byId !== 0 ? byId : a.index - b.index
    })
    .map(({ event }) => event)
}

/** Milliseconds since the prior chronological event, or null for bad timestamps. */
export function getInterEventDeltaMs(previous: RunEvent | undefined, current: RunEvent): number | null {
  if (!previous?.createdAt || !current.createdAt) return null
  const previousMs = Date.parse(previous.createdAt)
  const currentMs = Date.parse(current.createdAt)
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs < previousMs) return null
  return currentMs - previousMs
}

/** Summarize only the events currently loaded by the bounded run-history API. */
export function summarizeRunDiagnostics(events: RunEvent[]): RunDiagnostics {
  let firstTimestamp = Number.POSITIVE_INFINITY
  let lastTimestamp = Number.NEGATIVE_INFINITY
  let timestampCount = 0
  for (const event of events) {
    const timestamp = event.createdAt ? Date.parse(event.createdAt) : Number.NaN
    if (!Number.isFinite(timestamp)) continue
    firstTimestamp = Math.min(firstTimestamp, timestamp)
    lastTimestamp = Math.max(lastTimestamp, timestamp)
    timestampCount += 1
  }
  const observedDurationMs = timestampCount >= 2 ? lastTimestamp - firstTimestamp : null

  return {
    loadedEvents: events.length,
    observedDurationMs,
    retryCount: events.filter(event => event.type === 'node.retry').length,
    failedNodeCount: events.filter(event => event.type === 'node.failed').length,
    decisionCount: events.filter(event => event.type === 'decision.made').length,
    recalledEpisodeCount: events.reduce((total, event) => {
      if (event.type !== 'agent.memory.recalled') return total
      const count = event.payload && typeof event.payload === 'object'
        ? Number((event.payload as Record<string, unknown>).count)
        : Number.NaN
      return Number.isSafeInteger(count) && count > 0 ? total + count : total
    }, 0),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseCausalCandidate(value: unknown): CausalCandidate | null {
  const candidate = record(value)
  const breakdown = record(candidate?.breakdown)
  const nodeId = candidate?.nodeId
  const score = finiteNumber(candidate?.score)
  const cost = finiteNumber(breakdown?.cost)
  const latency = finiteNumber(breakdown?.latency)
  const quality = finiteNumber(breakdown?.quality)
  const penalty = finiteNumber(breakdown?.penalty)
  if (typeof nodeId !== 'string' || !nodeId || score === null || cost === null || latency === null || quality === null || penalty === null) {
    return null
  }
  return { nodeId, score, breakdown: { cost, latency, quality, penalty } }
}

function sameCausalCandidate(left: CausalCandidate, right: CausalCandidate): boolean {
  return left.nodeId === right.nodeId
    && left.score === right.score
    && left.breakdown.cost === right.breakdown.cost
    && left.breakdown.latency === right.breakdown.latency
    && left.breakdown.quality === right.breakdown.quality
    && left.breakdown.penalty === right.breakdown.penalty
}

/** Fail-closed parser for the legacy `/causal` response consumed by the web. */
export function parseCausalReplay(value: unknown): CausalReplay | null {
  const response = record(value)
  if (!response || !Array.isArray(response.ranking)) return null
  const parsedRanking = response.ranking.map(parseCausalCandidate)
  if (parsedRanking.length === 0 || parsedRanking.some(candidate => candidate === null)) return null
  const ranking = parsedRanking as CausalCandidate[]
  const chosenResponse = parseCausalCandidate(response.chosen)
  const bestResponse = parseCausalCandidate(response.best)
  if (!chosenResponse || !bestResponse) return null
  const ids = new Set(ranking.map(candidate => candidate.nodeId))
  if (ids.size !== ranking.length) return null
  if (ranking.some((candidate, index) => index > 0 && candidate.score < ranking[index - 1]!.score)) return null
  const best = ranking[0]!
  const chosen = ranking.find(candidate => candidate.nodeId === chosenResponse.nodeId)
  if (!chosen || !sameCausalCandidate(chosen, chosenResponse) || !sameCausalCandidate(best, bestResponse)) return null
  return { chosen, best, ranking }
}
