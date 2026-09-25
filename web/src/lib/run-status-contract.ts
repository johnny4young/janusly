import type { ApiResponses } from './api-types.generated'
import type { RunEvent, RunNode, RunSummary } from '../types'
import { isOptionalNullableRecord as objectOrAbsent } from './guards'
import { isGetStatusResponse } from './api-guards/operations/GetStatus'

// A validated display projection: extension JSON is narrowed to the object
// shapes consumed by the UI; wire pagination types come from the manifest.
export type RunStatusSnapshot = Pick<ApiResponses['GET /status'], 'eventsCursor' | 'eventsHasMore'> & {
  run: RunSummary
  nodes: RunNode[]
  events: RunEvent[]
}

/**
 * Validate the entire `/run` or `/status` projection before any store or
 * summary mutation. Shape is the generated guard's; the rules below are the
 * invariants the run polling, history and Replay Lab depend on.
 */
export function parseRunStatusSnapshot(value: unknown, runId: string): RunStatusSnapshot | null {
  if (!isGetStatusResponse(value)) return null
  const { run, nodes, events, eventsCursor, eventsHasMore } = value
  // useRunPolling patches the store for runId only, so every row must echo it.
  if (run.id !== runId || nodes.some(node => node.runId !== runId) || events.some(event => event.runId !== runId)) return null
  // The event history pager requests the next page with this cursor exactly when hasMore.
  if (eventsHasMore ? !eventsCursor : eventsCursor !== null) return null
  // Node ids and event ids key the canvas status overlay and the timeline rows.
  if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length
    || new Set(events.map(event => event.id)).size !== events.length) return null
  // The manifest leaves extension JSON opaque; the run inspector reads it as objects.
  if (![run.inputJson, run.outputJson].every(objectOrAbsent)
    || !nodes.every(node => objectOrAbsent(node.stateJson) && objectOrAbsent(node.errorJson))
    || !events.every(event => objectOrAbsent(event.payload))) return null
  return {
    run: run as RunSummary,
    nodes: nodes as RunNode[],
    events: events as RunEvent[],
    eventsCursor,
    eventsHasMore,
  }
}
