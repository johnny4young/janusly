/**
 * Pure event-order and presentation projections for the run-event timeline.
 * Kept separate from `eventUtils.ts` so multi-agent lazy chunks do not pull
 * the operator timeline into their shared dependency chunk.
 */

import type { RunEvent } from './types'

export type RunEventTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export type RunEventPresentation = {
  tone: RunEventTone
  noise: boolean
}

const NOISE_EVENT_TYPES = new Set(['node.queued', 'run.status_checked'])

/** Classify a low-level event without hiding any of it from the operator. */
export function getRunEventPresentation(event: RunEvent): RunEventPresentation {
  const type = event.type.toLowerCase()
  if (type.includes('failed') || type.includes('error') || type.includes('dead_letter')) {
    return { tone: 'error', noise: false }
  }
  if (type.includes('succeeded') || type.includes('completed') || type.includes('granted') || type.includes('submitted') || type.includes('resumed')) {
    return { tone: 'success', noise: false }
  }
  if (type.includes('waiting') || type.includes('retry') || type.includes('cancelled') || type.includes('rollback.triggered')) {
    return { tone: 'warning', noise: false }
  }
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
