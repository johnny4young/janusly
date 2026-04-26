import { describe, expect, it } from 'vitest'
import { summarizeRunStatus, toReasoningMessage, uniqueEvents } from './eventUtils'
import type { RunEvent } from './types'

describe('uniqueEvents', () => {
  it('deduplicates events by id', () => {
    const input: RunEvent[] = [
      { id: '1', type: 'node.succeeded' },
      { id: '1', type: 'node.succeeded' },
      { id: '2', type: 'node.failed' },
    ]

    const result = uniqueEvents(input)
    expect(result).toHaveLength(2)
    expect(result.map(e => e.id)).toEqual(['1', '2'])
  })

  it('falls back to a composite key when id is missing', () => {
    const input: RunEvent[] = [
      { id: undefined as unknown as string, type: 'node.succeeded', nodeId: 'a', createdAt: 't1' },
      { id: undefined as unknown as string, type: 'node.succeeded', nodeId: 'a', createdAt: 't1' },
      { id: undefined as unknown as string, type: 'node.succeeded', nodeId: 'a', createdAt: 't2' },
    ]
    expect(uniqueEvents(input)).toHaveLength(2)
  })
})

describe('toReasoningMessage', () => {
  it('maps failed events to the error tone with a message', () => {
    const message = toReasoningMessage({
      id: 'evt_1',
      type: 'node.failed',
      payload: { message: 'boom' },
    })

    expect(message).toEqual({
      id: 'evt_1',
      title: 'Error',
      body: 'boom',
      tone: 'error',
    })
  })

  it('maps multi_agent events to the info tone', () => {
    const message = toReasoningMessage({
      id: 'evt_2',
      type: 'multi_agent.started',
      payload: { count: 2 },
    })

    expect(message?.tone).toBe('info')
    expect(message?.title).toBe('multi_agent.started')
  })

  it('marks completed as success', () => {
    const message = toReasoningMessage({
      id: 'evt_3',
      type: 'node.completed',
      payload: {},
    })

    expect(message?.tone).toBe('success')
  })

  it('returns null for unknown event types', () => {
    const message = toReasoningMessage({
      id: 'evt_4',
      type: 'node.queued',
      payload: {},
    })

    expect(message).toBeNull()
  })
})

describe('summarizeRunStatus', () => {
  it('counts every status bucket correctly', () => {
    const summary = summarizeRunStatus([
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'failed' },
      { status: 'running' },
      { status: 'waiting' },
      { status: 'pending' },
      { status: 'queued' },
    ])

    expect(summary).toEqual({ total: 7, succeeded: 2, failed: 1, running: 1, waiting: 1, pending: 2 })
  })

  it('supports an empty list', () => {
    expect(summarizeRunStatus([])).toEqual({ total: 0, succeeded: 0, failed: 0, running: 0, waiting: 0, pending: 0 })
  })
})
