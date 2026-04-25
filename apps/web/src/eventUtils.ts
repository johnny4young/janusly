import { RunEvent, ReasoningMessage } from './types'

export function uniqueEvents(events: RunEvent[]) {
  const seen = new Set<string>()
  return events.filter(e => {
    const key = e.id ?? `${e.type}:${e.nodeId}:${e.createdAt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function toReasoningMessage(event: RunEvent): ReasoningMessage | null {
  const p = event.payload ?? {}

  if (event.type.includes('multi_agent')) {
    return {
      id: event.id,
      title: event.type,
      body: JSON.stringify(p).slice(0, 200),
      tone: 'info'
    }
  }

  if (event.type.includes('failed')) return { id: event.id, title: 'Error', body: p.message ?? 'Failure', tone: 'error' }
  if (event.type.includes('completed')) return { id: event.id, title: 'Done', body: 'Completed', tone: 'success' }

  return null
}
