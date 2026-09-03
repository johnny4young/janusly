/**
 * Shared run-event helpers: stable deduplication and node-state aggregation.
 * Timeline-specific order and presentation live in `run-timeline.ts` so they
 * do not inflate the multi-agent lazy dependency chunk.
 *
 * Used by `MultiAgentTimeline.tsx`, `components/RightPanel.tsx:ReasoningPanel`,
 * and `store.ts` (`bumpPlatformVersion` after merging an events page).
 */

import type { RunEvent } from './types'

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
