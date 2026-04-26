import { describe, expect, it } from 'vitest'
import { toReasoningMessage, uniqueEvents } from './eventUtils'

describe('eventUtils', () => {
  it('deduplica eventos por id', () => {
    const input = [
      { id: '1', type: 'node.succeeded' },
      { id: '1', type: 'node.succeeded' },
      { id: '2', type: 'node.failed' },
    ] as any

    const result = uniqueEvents(input)
    expect(result).toHaveLength(2)
  })

  it('mapea eventos failed a mensaje de error', () => {
    const msg = toReasoningMessage({
      id: 'evt_1',
      type: 'node.failed',
      payload: { message: 'boom' },
    } as any)

    expect(msg).toEqual({
      id: 'evt_1',
      title: 'Error',
      body: 'boom',
      tone: 'error',
    })
  })

  it('mapea eventos multi_agent a mensaje informativo', () => {
    const msg = toReasoningMessage({
      id: 'evt_2',
      type: 'multi_agent.started',
      payload: { count: 2 },
    } as any)

    expect(msg?.tone).toBe('info')
    expect(msg?.title).toBe('multi_agent.started')
  })
})
