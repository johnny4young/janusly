import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appendEventMock,
  enqueueNodeMock,
  markQueuePublicationSucceededMock,
  checkpointUpdateMock,
  checkpointResult,
  parentRunStatus,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  transactionState,
  txInsertMock,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
  markQueuePublicationSucceededMock: vi.fn().mockResolvedValue(true),
  checkpointUpdateMock: vi.fn(),
  checkpointResult: { value: true },
  parentRunStatus: { value: 'running' },
  runEventsTable: { name: 'runEvents' },
  runNodesTable: {
    name: 'runNodes',
    id: 'runNodes.id',
    runId: 'runNodes.runId',
    nodeId: 'runNodes.nodeId',
    status: 'runNodes.status',
    recoveryClaimToken: 'runNodes.recoveryClaimToken',
  },
  runsTable: { name: 'runs', id: 'runs.id', status: 'runs.status' },
  safePersistPayloadMock: vi.fn((payload: unknown) => ({ sanitized: payload })),
  transactionState: { finished: false },
  txInsertMock: vi.fn(),
}))

vi.mock('@janusly/db', () => ({
  db: {
    transaction: async (fn: any) => {
      transactionState.finished = false
      try {
        return await fn({
          insert: (table: unknown) => ({
            values: (values: unknown) => {
              txInsertMock(table, values)
              return Promise.resolve(undefined)
            },
          }),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: () => Promise.resolve([{ status: parentRunStatus.value }]),
                }),
              }),
            }),
          }),
          update: (table: unknown) => ({
            set: (values: unknown) => ({
              where: (predicate: unknown) => ({
                returning: () => {
                  checkpointUpdateMock(table, values, predicate)
                  return Promise.resolve(checkpointResult.value ? [{ id: 'parent-node-row' }] : [])
                },
              }),
            }),
          }),
        })
      } finally {
        transactionState.finished = true
      }
    },
  },
  runs: runsTable,
  runNodes: runNodesTable,
  runEvents: runEventsTable,
}))

vi.mock('drizzle-orm', () => ({
  and: (...predicates: unknown[]) => ({ and: predicates }),
  eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
  isNull: (value: unknown) => ({ isNull: value }),
}))

vi.mock('./queue', () => ({
  enqueueNode: enqueueNodeMock,
}))

vi.mock('./persistence', () => ({
  markQueuePublicationSucceeded: markQueuePublicationSucceededMock,
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
    markQueuePublicationSucceededMock.mockClear()
    appendEventMock.mockClear()
    checkpointUpdateMock.mockClear()
    safePersistPayloadMock.mockClear()
    checkpointResult.value = true
    parentRunStatus.value = 'running'
    transactionState.finished = false
    enqueueNodeMock.mockResolvedValue(undefined)
  })

  it('sanitizes initial run_nodes.state_json and run_events.payload writes inside the transaction', async () => {
    await startRun({
      dslVersion: '1.0',
      id: 'workflow-version-1',
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    })

    const runNodesWrite = txInsertMock.mock.calls.find(([table]) => table === runNodesTable)?.[1] as Array<{
      stateJson: unknown
      status: string
      attempts: number
      queuePublicationRepairAfter: Date | null
      queuePublicationGeneration: number
    }>
    const runEventWrite = txInsertMock.mock.calls.find(([table]) => table === runEventsTable)?.[1] as { payload: unknown }
    const runWrite = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1] as { traceId: unknown }

    expect(runNodesWrite[0].stateJson).toEqual({ sanitized: {} })
    expect(runNodesWrite[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    })
    expect(runEventWrite.payload).toEqual({ sanitized: { workflowVersionId: 'workflow-version-1' } })
    expect(runWrite.traceId).toEqual(expect.any(String))
    expect(safePersistPayloadMock).toHaveBeenCalledWith({}, { maxBytes: 1_000_000 })
    expect(safePersistPayloadMock).toHaveBeenCalledWith({ workflowVersionId: 'workflow-version-1' })
    expect(enqueueNodeMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'start',
      attempt: 1,
      publicationGeneration: 1,
    }))
    expect(markQueuePublicationSucceededMock).toHaveBeenCalledWith(expect.any(String), 'start', 1, 1, undefined)
  })

  it('returns the committed run when immediate queue publication is unavailable', async () => {
    enqueueNodeMock.mockRejectedValueOnce(new Error('redis unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(startRun({
      dslVersion: '1.0',
      id: 'workflow-version-1',
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    })).resolves.toEqual(expect.objectContaining({ runId: expect.any(String) }))

    expect(markQueuePublicationSucceededMock).not.toHaveBeenCalled()
    expect(appendEventMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[initial-node-publication] immediate publication deferred',
      expect.objectContaining({ nodeId: 'start', stage: 'enqueue', errorName: 'Error' }),
    )
    warn.mockRestore()
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

  it('commits the exact parent waiting checkpoint before publishing child roots', async () => {
    enqueueNodeMock.mockImplementation(async () => {
      expect(transactionState.finished).toBe(true)
      expect(checkpointUpdateMock).toHaveBeenCalledTimes(1)
    })

    const result = await startRun({
      dslVersion: '1.0',
      id: 'child-workflow',
      nodes: [{ id: 'child-root', type: 'noop', config: {} }],
      edges: [],
      parentRunId: 'parent-run',
      parentNodeId: 'call-child',
      replayMode: 'validation',
      parentCheckpoint: {
        waitingMetadata: { kind: 'subworkflow', childWorkflowId: 'child-workflow' },
        startedEventPayload: { childWorkflowId: 'child-workflow' },
        recoveryClaimToken: 'recovery-generation',
      },
    })

    const [, checkpointValues, checkpointPredicate] = checkpointUpdateMock.mock.calls[0] as [
      unknown,
      { status: string; stateJson: unknown },
      unknown,
    ]
    expect(checkpointValues).toMatchObject({
      status: 'waiting',
      stateJson: { sanitized: { waiting: expect.objectContaining({ childRunId: result.runId }) } },
    })
    expect(checkpointPredicate).toEqual(expect.objectContaining({
      and: expect.arrayContaining([
        { eq: ['runNodes.recoveryClaimToken', 'recovery-generation'] },
      ]),
    }))
    const parentEventWrite = txInsertMock.mock.calls
      .filter(([table]) => table === runEventsTable)
      .map(([, values]) => values)
      .find(Array.isArray) as Array<{ runId: string; nodeId: string; type: string }>
    expect(parentEventWrite.map(event => event.type)).toEqual([
      'node.subworkflow.started',
      'node.waiting',
    ])
    expect(parentEventWrite.every(event => event.runId === 'parent-run' && event.nodeId === 'call-child')).toBe(true)
    const runWrite = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1] as {
      parentLinkKind: string | null
      replayMode: string | null
    }
    expect(runWrite).toMatchObject({
      parentLinkKind: 'subworkflow',
      replayMode: 'validation',
    })
    expect(enqueueNodeMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: result.runId,
      nodeId: 'child-root',
    }))
  })

  it('does not create or publish a child when the parent checkpoint lost its claim', async () => {
    checkpointResult.value = false

    await expect(startRun({
      dslVersion: '1.0',
      id: 'child-workflow',
      nodes: [{ id: 'child-root', type: 'noop', config: {} }],
      edges: [],
      parentRunId: 'parent-run',
      parentNodeId: 'call-child',
      parentCheckpoint: {
        waitingMetadata: { kind: 'subworkflow' },
        startedEventPayload: { childWorkflowId: 'child-workflow' },
      },
    })).rejects.toThrow('Parent subworkflow node is no longer claimable')
    expect(txInsertMock).not.toHaveBeenCalled()
    expect(enqueueNodeMock).not.toHaveBeenCalled()
  })
})
