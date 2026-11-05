import { describe, expect, it } from 'vitest'

import { projectRunSteps } from './run-steps'
import type { RunEvent } from './types'

const at = (ms: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, 0, ms)).toISOString()
const event = (type: string, ms: number, payload?: RunEvent['payload'], nodeId: string | null = 'fetch'): RunEvent => ({
  id: `${type}-${ms}`,
  type,
  nodeId,
  createdAt: at(ms),
  payload,
})

describe('projectRunSteps', () => {
  it('groups attempts by step with their outcome, timing and retry count', () => {
    const { steps, startMs, endMs } = projectRunSteps([
      event('run.started', 0, undefined, null),
      event('node.queued', 1),
      event('node.running', 4, { attempt: 1 }),
      event('node.retry', 31, { attempt: 2, error: { message: 'boom 1' } }),
      event('node.running', 41, { attempt: 2 }),
      event('node.succeeded', 52, { attempt: 2 }),
      event('node.running', 60, { attempt: 1 }, 'shape'),
      event('node.succeeded', 70, { attempt: 1 }, 'shape'),
    ], [
      { nodeId: 'fetch', status: 'succeeded', attempts: 2, startedAt: at(41), finishedAt: at(52) },
      { nodeId: 'shape', status: 'succeeded', attempts: 1, startedAt: at(60), finishedAt: at(70) },
    ])

    expect(steps.map(step => step.nodeId)).toEqual(['fetch', 'shape'])
    expect(steps[0]).toMatchObject({ status: 'succeeded', retries: 1 })
    expect(steps[0]?.attempts).toEqual([
      { attempt: 1, outcome: 'retried', startedAt: Date.parse(at(4)), finishedAt: Date.parse(at(31)), error: 'boom 1' },
      { attempt: 2, outcome: 'succeeded', startedAt: Date.parse(at(41)), finishedAt: Date.parse(at(52)), error: null },
    ])
    expect(steps[1]?.retries).toBe(0)
    expect(endMs - startMs).toBe(66)
  })

  it('orders events that arrive out of order before pairing attempts', () => {
    const { steps } = projectRunSteps([
      event('node.failed', 20, { attempt: 1, error: { message: 'gone' } }),
      event('node.running', 10, { attempt: 1 }),
    ], [])

    expect(steps[0]?.attempts).toMatchObject([{ attempt: 1, outcome: 'failed', error: 'gone' }])
  })

  it('takes the end of a waiting attempt from the node row', () => {
    const { steps } = projectRunSteps([
      event('node.running', 4, { attempt: 1 }, 'call'),
      event('node.waiting', 10, { status: 'waiting' }, 'call'),
      event('subworkflow.completed', 24, {}, 'call'),
    ], [{ nodeId: 'call', status: 'succeeded', attempts: 1, startedAt: at(1), finishedAt: at(26) }])

    expect(steps[0]?.attempts).toEqual([
      { attempt: 1, outcome: 'succeeded', startedAt: Date.parse(at(4)), finishedAt: Date.parse(at(26)), error: null },
    ])
  })

  it('reports a live wait as waiting, not running', () => {
    const { steps } = projectRunSteps([
      event('node.running', 4, { attempt: 1 }, 'gate'),
      event('node.waiting', 10, {}, 'gate'),
    ], [])

    expect(steps[0]?.attempts[0]).toMatchObject({ outcome: 'waiting', finishedAt: null })
  })

  it('keeps one attempt when a resumed step runs again', () => {
    const { steps } = projectRunSteps([
      event('node.running', 4, { attempt: 1 }, 'gate'),
      event('node.waiting', 10, {}, 'gate'),
      event('node.running', 20, { attempt: 1 }, 'gate'),
    ], [])

    expect(steps[0]?.attempts).toHaveLength(1)
    expect(steps[0]?.attempts[0]).toMatchObject({ outcome: 'running', startedAt: Date.parse(at(4)) })
  })

  it('keeps a retried attempt when the requeued row is queued or running', () => {
    const events = [
      event('node.running', 4, { attempt: 1 }),
      event('node.retry', 31, { attempt: 2 }),
    ]

    for (const status of ['queued', 'running']) {
      const { steps } = projectRunSteps(events, [{ nodeId: 'fetch', status, attempts: 2 }])
      expect(steps[0]?.status).toBe(status)
      expect(steps[0]?.attempts.map(item => item.outcome)).toEqual(['retried'])
    }
  })

  it('keeps the failed attempt when a redrive requeues the row', () => {
    const { steps } = projectRunSteps([
      event('node.running', 4, { attempt: 1 }),
      event('node.failed', 10, { attempt: 1, error: { message: 'gone' } }),
    ], [{ nodeId: 'fetch', status: 'queued', attempts: 1 }])

    expect(steps[0]?.status).toBe('queued')
    expect(steps[0]?.attempts[0]).toMatchObject({ outcome: 'failed', error: 'gone' })
  })

  it('falls back to the row when older events are not loaded', () => {
    const { steps, startMs, endMs } = projectRunSteps([], [{
      nodeId: 'fetch',
      status: 'failed',
      attempts: 3,
      startedAt: at(10),
      finishedAt: at(30),
      errorJson: { message: 'still down' },
    }])

    expect(steps[0]).toMatchObject({ retries: 2 })
    expect(steps[0]?.attempts).toEqual([
      { attempt: 3, outcome: 'failed', startedAt: Date.parse(at(10)), finishedAt: Date.parse(at(30)), error: 'still down' },
    ])
    expect(endMs - startMs).toBe(20)
  })

  it('lists a step that never started without an attempt', () => {
    const { steps, startMs, endMs } = projectRunSteps([], [{ nodeId: 'later', status: 'skipped', attempts: 0 }])

    expect(steps).toEqual([{ nodeId: 'later', status: 'skipped', retries: 0, attempts: [] }])
    expect(endMs - startMs).toBe(0)
  })

  it('numbers attempts when the event carries no attempt', () => {
    const { steps } = projectRunSteps([
      event('node.running', 4),
      event('node.retry', 10),
      event('node.running', 20),
    ], [])

    expect(steps[0]?.attempts.map(item => item.attempt)).toEqual([1, 2])
  })

  it('leaves run-level events out of the steps', () => {
    const { steps } = projectRunSteps([event('run.status_checked', 900000, undefined, null)], [])

    expect(steps).toEqual([])
  })
})
