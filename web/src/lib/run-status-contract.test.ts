import { describe, expect, it } from 'vitest'
import { parseRunStatusSnapshot } from './run-status-contract'

const snapshot = () => ({
  run: { id: 'run-a', status: 'running', orgId: 'org-a', createdBy: null, createdAt: null, inputJson: {}, outputJson: null },
  nodes: [{ nodeId: 'work', runId: 'run-a', status: 'running', stateJson: {}, errorJson: null, attempts: 1 }],
  events: [{ id: 'event-a', runId: 'run-a', nodeId: 'work', type: 'node.running', payload: {}, createdAt: '2026-09-21T00:00:00.000Z' }],
  eventsCursor: null,
  eventsHasMore: false,
})

describe('run status snapshot boundary', () => {
  it('accepts nullable persisted metadata, empty lists and additive fields', () => {
    expect(parseRunStatusSnapshot(snapshot(), 'run-a')).toEqual(snapshot())
    expect(parseRunStatusSnapshot({ ...snapshot(), events: [{ ...snapshot().events[0], createdAt: null }] }, 'run-a')).not.toBeNull()
    expect(parseRunStatusSnapshot({ ...snapshot(), nodes: [], events: [], futureField: true }, 'run-a')).toMatchObject({ nodes: [], events: [] })
  })

  it('leaves page sizes to the server', () => {
    const events = Array.from({ length: 501 }, (_, index) => ({ id: `event-${index}`, type: 'node.running' }))
    const nodes = Array.from({ length: 501 }, (_, index) => ({ nodeId: `node-${index}`, status: 'pending' }))
    expect(parseRunStatusSnapshot({ ...snapshot(), nodes, events }, 'run-a')).not.toBeNull()
  })

  it('accepts a complete paginated latest page', () => {
    expect(parseRunStatusSnapshot({ ...snapshot(), eventsCursor: 'cursor-a', eventsHasMore: true }, 'run-a')).not.toBeNull()
  })

  it.each([null, [], {}, 'run-a', { run: { id: 'run-a', status: 'running' } }])('rejects non-snapshots: %j', payload => {
    expect(parseRunStatusSnapshot(payload, 'run-a')).toBeNull()
  })

  it.each([
    { run: { id: 'run-b', status: 'running' } },
    { run: { id: 'run-a', status: 'finished' } },
    { run: { id: 'run-a', status: 'running', inputJson: [] } },
    { run: { id: 'run-a', status: 'running', createdAt: 123 } },
    { run: { id: 'run-a', status: 'running', outcomeStatus: ['semantic_recovered'] } },
    { run: { id: 'run-a', status: 'running', semanticViolationCount: -1 } },
    { run: { id: 'run-a', status: 'running', validationEvidenceLevel: 'unverified' } },
    { nodes: null },
    { nodes: [{}] },
    { nodes: [{ nodeId: 'work', status: 'running', runId: 'run-b' }] },
    { nodes: [{ nodeId: 'work', status: 'running', attempts: 1.5 }] },
    { nodes: [{ nodeId: 'work', status: 'running', stateJson: [] }] },
    { nodes: [{ nodeId: 'work', status: 'running' }, { nodeId: 'work', status: 'failed' }] },
    { events: [null] },
    { events: [{ id: 'event', type: 42 }] },
    { events: [{ id: 'event', type: 'node.running', runId: 'run-b' }] },
    { events: [{ id: 'event', type: 'node.running', payload: [] }] },
    { events: [{ id: 'event', type: 'node.running' }, { id: 'event', type: 'node.running' }] },
    { eventsHasMore: 'true' },
    { eventsHasMore: true, eventsCursor: null },
    { eventsHasMore: true, eventsCursor: '' },
    { eventsHasMore: false, eventsCursor: 'stale' },
  ])('rejects malformed or cross-run projections atomically: %j', patch => {
    expect(parseRunStatusSnapshot({ ...snapshot(), ...patch }, 'run-a')).toBeNull()
  })
})
