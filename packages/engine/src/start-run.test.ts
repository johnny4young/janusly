import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appendEventMock,
  enqueueNodeMock,
  markNodeQueuedMock,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  txInsertMock,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
  markNodeQueuedMock: vi.fn().mockResolvedValue(undefined),
  runEventsTable: { name: 'runEvents' },
  runNodesTable: { name: 'runNodes' },
  runsTable: { name: 'runs' },
  safePersistPayloadMock: vi.fn((payload: unknown) => ({ sanitized: payload })),
  txInsertMock: vi.fn(),
}))

vi.mock('@janusly/db', () => ({
  db: {
    transaction: (fn: any) => fn({
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          txInsertMock(table, values)
          return Promise.resolve(undefined)
        },
      }),
    }),
  },
  runs: runsTable,
  runNodes: runNodesTable,
  runEvents: runEventsTable,
}))

vi.mock('./queue', () => ({
  enqueueNode: enqueueNodeMock,
}))

vi.mock('./persistence', () => ({
  markNodeQueued: markNodeQueuedMock,
  appendEvent: appendEventMock,
}))

vi.mock('./safe-persist', () => ({
  safePersistPayload: safePersistPayloadMock,
}))

import { startRun } from './start-run'

describe('startRun persistence chokepoint', () => {
  beforeEach(() => {
    txInsertMock.mockClear()
    enqueueNodeMock.mockClear()
    markNodeQueuedMock.mockClear()
    appendEventMock.mockClear()
    safePersistPayloadMock.mockClear()
  })

  it('sanitizes initial run_nodes.state_json and run_events.payload writes inside the transaction', async () => {
    await startRun({
      dslVersion: '1.0',
      id: 'workflow-version-1',
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    })

    const runNodesWrite = txInsertMock.mock.calls.find(([table]) => table === runNodesTable)?.[1] as Array<{ stateJson: unknown }>
    const runEventWrite = txInsertMock.mock.calls.find(([table]) => table === runEventsTable)?.[1] as { payload: unknown }
    const runWrite = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1] as { traceId: unknown }

    expect(runNodesWrite[0].stateJson).toEqual({ sanitized: {} })
    expect(runEventWrite.payload).toEqual({ sanitized: { workflowVersionId: 'workflow-version-1' } })
    expect(runWrite.traceId).toEqual(expect.any(String))
    expect(safePersistPayloadMock).toHaveBeenCalledWith({}, { maxBytes: 1_000_000 })
    expect(safePersistPayloadMock).toHaveBeenCalledWith({ workflowVersionId: 'workflow-version-1' })
  })

  it('preserves an inherited trace id for subworkflow correlation', async () => {
    await startRun({
      dslVersion: '1.0',
      id: 'child-workflow',
      traceId: 'trace-parent',
      nodes: [],
      edges: [],
    })

    const runWrite = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1] as { traceId: unknown }
    expect(runWrite.traceId).toBe('trace-parent')
  })
})
