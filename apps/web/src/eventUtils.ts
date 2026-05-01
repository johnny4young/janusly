/**
 * Pure helpers for the Multi-agent timeline + Reasoning panel: dedupe
 * events, project to display shape, and summarise run status from node
 * states. No I/O — used by both panels and the store reducer.
 *
 * Used by `MultiAgentTimeline.tsx`, `components/RightPanel.tsx:ReasoningPanel`,
 * and `store.ts` (`bumpPlatformVersion` after merging an events page).
 */

import type { ReasoningMessage, RunEvent } from './types'

/** Dedupe a `RunEvent[]` by id (or composite key when id is missing). Stable order. */
export function uniqueEvents(events: RunEvent[]): RunEvent[] {
  const seen = new Set<string>()
  return events.filter(event => {
    const key = event.id ?? `${event.type}:${event.nodeId}:${event.createdAt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Project a single `RunEvent` to a `ReasoningMessage` for the Reasoning panel; returns `null` for events the panel ignores. */
export function toReasoningMessage(event: RunEvent): ReasoningMessage | null {
  const payload = event.payload ?? {}

  if (event.type.includes('multi_agent')) {
    return {
      id: event.id,
      title: event.type,
      body: JSON.stringify(payload).slice(0, 200),
      tone: 'info',
    }
  }

  if (event.type.includes('failed')) {
    return {
      id: event.id,
      title: 'Error',
      body: typeof payload.message === 'string' ? payload.message : 'Failure',
      tone: 'error',
    }
  }

  if (event.type.includes('completed')) {
    return {
      id: event.id,
      title: 'Done',
      body: 'Completed',
      tone: 'success',
    }
  }

  return null
}

/** Aggregate per-node statuses into completed / waiting / failed counts for the run header chip. */
export function summarizeRunStatus(nodes: Array<{ status: string }>): {
  total: number
  succeeded: number
  failed: number
  running: number
  waiting: number
  pending: number
} {
  const summary = { total: nodes.length, succeeded: 0, failed: 0, running: 0, waiting: 0, pending: 0 }
  for (const node of nodes) {
    if (node.status === 'succeeded') summary.succeeded++
    else if (node.status === 'failed') summary.failed++
    else if (node.status === 'running') summary.running++
    else if (node.status === 'waiting') summary.waiting++
    else if (node.status === 'pending' || node.status === 'queued') summary.pending++
  }
  return summary
}
