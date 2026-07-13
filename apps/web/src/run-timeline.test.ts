import { describe, expect, it } from 'vitest'
import type { RunEvent } from './types'
import { getInterEventDeltaMs, getRunEventPresentation, sortRunEventsChronologically } from './run-timeline'

describe('run event timeline projection', () => {
  it('maps lifecycle families to semantic tones', () => {
    expect(getRunEventPresentation({ id: '1', type: 'node.failed' }).tone).toBe('error')
    expect(getRunEventPresentation({ id: '2', type: 'node.succeeded' }).tone).toBe('success')
    expect(getRunEventPresentation({ id: '3', type: 'node.waiting' }).tone).toBe('warning')
    expect(getRunEventPresentation({ id: '4', type: 'node.running' }).tone).toBe('info')
  })

  it('keeps queue and status-check noise visible but marks it for de-emphasis', () => {
    expect(getRunEventPresentation({ id: '1', type: 'node.queued' })).toEqual({ tone: 'neutral', noise: true })
    expect(getRunEventPresentation({ id: '2', type: 'run.status_checked' })).toEqual({ tone: 'neutral', noise: true })
    expect(getRunEventPresentation({ id: '3', type: 'custom.signal' })).toEqual({ tone: 'neutral', noise: false })
  })

  it('computes chronological deltas and rejects malformed or reversed timestamps', () => {
    const previous = { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' }
    expect(getInterEventDeltaMs(previous, { id: '2', type: 'node.running', createdAt: '2026-07-12T10:00:01.250Z' })).toBe(1_250)
    expect(getInterEventDeltaMs(previous, { id: '3', type: 'node.running', createdAt: 'bad' })).toBeNull()
    expect(getInterEventDeltaMs(previous, { id: '4', type: 'node.running', createdAt: '2026-07-12T09:59:59.000Z' })).toBeNull()
  })

  it('normalizes API-descending and streamed event order without mutating the input', () => {
    const events: RunEvent[] = [
      { id: '3', type: 'run.failed', createdAt: '2026-07-12T10:00:03.000Z' },
      { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: '2', type: 'node.running', createdAt: '2026-07-12T10:00:01.000Z' },
    ]
    expect(sortRunEventsChronologically(events).map(event => event.id)).toEqual(['1', '2', '3'])
    expect(events.map(event => event.id)).toEqual(['3', '1', '2'])
  })
})
