import { describe, expect, it } from 'vitest'
import { parseRunStatusSnapshot } from './run-status-contract'

const run = {
  id: 'run-a', orgId: 'org-a', status: 'running', createdAt: null, createdBy: null, inputJson: {}, outputJson: null,
  outcomeStatus: null, parentLinkKind: null, parentNodeId: null, parentNotificationAfter: null, parentRunId: null,
  recoveryPlaybookAppliedRecordedAt: null, recoveryPlaybookValidationRecordedAt: null, replayMode: null,
  semanticViolationCount: 0, traceId: null, validationEvidenceLevel: null, workflowRolloutId: null,
  workflowRolloutVariant: null, workflowVersionId: 'version-a',
}
const node = {
  id: 'node-row-a', nodeId: 'work', runId: 'run-a', status: 'running', stateJson: {}, errorJson: null,
  attempts: 1, startedAt: null, finishedAt: null,
}
const event = {
  id: 'event-a', runId: 'run-a', nodeId: 'work', type: 'node.running', payload: {},
  createdAt: '2026-09-21T00:00:00.000Z', holdUntil: null,
}
const snapshot = () => ({ run, nodes: [node], events: [event], eventsCursor: null, eventsHasMore: false })

describe('run status snapshot boundary', () => {
  it('accepts nullable persisted metadata and empty lists', () => {
    expect(parseRunStatusSnapshot(snapshot(), 'run-a')).toEqual(snapshot())
    expect(parseRunStatusSnapshot({ ...snapshot(), events: [{ ...event, createdAt: null }] }, 'run-a')).not.toBeNull()
    expect(parseRunStatusSnapshot({ ...snapshot(), nodes: [], events: [] }, 'run-a')).toMatchObject({ nodes: [], events: [] })
  })

  it('leaves page sizes to the server', () => {
    const events = Array.from({ length: 501 }, (_, index) => ({ ...event, id: `event-${index}` }))
    const nodes = Array.from({ length: 501 }, (_, index) => ({ ...node, nodeId: `node-${index}` }))
    expect(parseRunStatusSnapshot({ ...snapshot(), nodes, events }, 'run-a')).not.toBeNull()
  })

  it('accepts a complete paginated latest page', () => {
    expect(parseRunStatusSnapshot({ ...snapshot(), eventsCursor: 'cursor-a', eventsHasMore: true }, 'run-a')).not.toBeNull()
  })

  it.each([null, [], {}, 'run-a', { ...snapshot(), run: { ...run, status: 'finished' } }, { ...snapshot(), futureField: true }])(
    'delegates shape to the generated guard: %j', payload => {
      expect(parseRunStatusSnapshot(payload, 'run-a')).toBeNull()
    })

  it.each([
    { run: { ...run, id: 'run-b' } },
    { run: { ...run, inputJson: [] } },
    { nodes: [{ ...node, runId: 'run-b' }] },
    { nodes: [{ ...node, stateJson: [] }] },
    { nodes: [node, { ...node, status: 'failed' }] },
    { events: [{ ...event, runId: 'run-b' }] },
    { events: [{ ...event, payload: [] }] },
    { events: [event, event] },
    { eventsHasMore: true, eventsCursor: null },
    { eventsHasMore: true, eventsCursor: '' },
    { eventsHasMore: false, eventsCursor: 'stale' },
  ])('rejects cross-run or unusable projections atomically: %j', patch => {
    expect(parseRunStatusSnapshot({ ...snapshot(), ...patch }, 'run-a')).toBeNull()
  })
})
