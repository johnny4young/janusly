import type { ReasoningMessage, RunEvent } from './types'

export function uniqueEvents(events: RunEvent[]): RunEvent[] {
  const seen = new Set<string>()
  return events.filter(event => {
    const key = event.id ?? `${event.type}:${event.nodeId}:${event.createdAt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

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
