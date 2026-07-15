import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appendEventMock,
  enqueueNodeMock,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  txInsertMock,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
  runEventsTable: { name: 'runEvents' },
  runNodesTable: { name: 'runNodes' },
  runsTable: { name: 'runs' },
  safePersistPayloadMock: vi.fn((payload: unknown) => payload),
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

vi.mock('../queue', () => ({
  enqueueNode: enqueueNodeMock,
}))

vi.mock('../persistence', () => ({
  markQueuePublicationSucceeded: vi.fn().mockResolvedValue(true),
  appendEvent: appendEventMock,
}))

vi.mock('../safe-persist', () => ({
  safePersistPayload: safePersistPayloadMock,
}))

import { replayRunAsValidation } from './replay-lab'

const linearWorkflow = {
  dslVersion: '1.0' as const,
  nodes: [
    { id: 'fetch', type: 'http' as const, config: { url: 'https://x.example', method: 'GET' } },
    { id: 'transform', type: 'transform' as const, config: { mapping: {} } },
    { id: 'finish', type: 'noop' as const, config: {} },
  ],
  edges: [
    { from: 'fetch', to: 'transform' },
    { from: 'transform', to: 'finish' },
  ],
}

const forkWorkflow = {
  dslVersion: '1.0' as const,
  nodes: [
    { id: 'root_a', type: 'noop' as const, config: {} },
    { id: 'root_b', type: 'noop' as const, config: {} },
    { id: 'join', type: 'noop' as const, config: {} },
  ],
  edges: [
    { from: 'root_a', to: 'join' },
    { from: 'root_b', to: 'join' },
  ],
}

beforeEach(() => {
  txInsertMock.mockReset()
  enqueueNodeMock.mockReset()
  appendEventMock.mockReset()
})

describe('replayRunAsValidation', () => {
  it('creates a sandbox run with roots durably queued and downstream nodes pending', async () => {
    const result = await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
      createdBy: 'user-1',
    })

    expect(result.runId).toEqual(expect.any(String))

    const runsInsert = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect(runsInsert).toBeDefined()
    expect(runsInsert![1]).toMatchObject({
      id: result.runId,
      orgId: 'org-1',
      replayMode: 'validation',
      workflowVersionId: result.runId,
      parentRunId: 'src-run',
      parentNodeId: null,
      status: 'running',
      createdBy: 'user-1',
    })

    const nodesInsert = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)
    expect(nodesInsert).toBeDefined()
    const rows = nodesInsert![1] as Array<{
      nodeId: string
      status: string
      stateJson: unknown
      attempts: number
      queuePublicationRepairAfter: Date | null
      queuePublicationGeneration: number
    }>
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.nodeId === 'fetch')).toMatchObject({
      status: 'queued',
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    })
    for (const row of rows.filter((candidate) => candidate.nodeId !== 'fetch')) {
      expect(row).toMatchObject({
        status: 'pending',
        attempts: 0,
        queuePublicationRepairAfter: null,
        queuePublicationGeneration: 0,
      })
    }
    expect(rows.every((row) => JSON.stringify(row.stateJson) === '{}')).toBe(true)
  })

  it('emits a run.started.replay-lab event with sourceRunId + hasPatch', async () => {
    const result = await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
      hasPatch: true,
    })

    const eventInsert = txInsertMock.mock.calls.find((args) => args[0] === runEventsTable)
    expect(eventInsert).toBeDefined()
    expect(eventInsert![1]).toMatchObject({
      runId: result.runId,
      type: 'run.started.replay-lab',
    })
    const payload = (eventInsert![1] as { payload: { sourceRunId: string; hasPatch: boolean } }).payload
    expect(payload.sourceRunId).toBe('src-run')
    expect(payload.hasPatch).toBe(true)
  })

  it('defaults hasPatch to false when not provided', async () => {
    await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
    })

    const eventInsert = txInsertMock.mock.calls.find((args) => args[0] === runEventsTable)
    const payload = (eventInsert![1] as { payload: { hasPatch: boolean } }).payload
    expect(payload.hasPatch).toBe(false)
  })

  it('persists the workflow snapshot + trigger input in inputJson', async () => {
    await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
      input: { invoiceId: 'inv-42' },
    })

    const runsInsert = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect((runsInsert![1] as { inputJson: { workflow: unknown; input: unknown } }).inputJson).toEqual({
      workflow: linearWorkflow,
      input: { invoiceId: 'inv-42' },
    })
  })

  it('defaults trigger input to {} when the caller omits it (ad-hoc fallback)', async () => {
    await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
    })

    const runsInsert = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect((runsInsert![1] as { inputJson: { workflow: unknown; input: unknown } }).inputJson).toEqual({
      workflow: linearWorkflow,
      input: {},
    })
  })

  it('enqueues only root nodes (no incoming edges) for a linear DAG', async () => {
    const result = await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
    })

    expect(enqueueNodeMock).toHaveBeenCalledTimes(1)
    expect(enqueueNodeMock.mock.calls[0][0]).toMatchObject({
      runId: result.runId,
      nodeId: linearWorkflow.nodes[0].id,
      attempt: 1,
    })
    expect(appendEventMock).toHaveBeenCalledWith(result.runId, 'fetch', 'node.queued', {})
  })

  it('enqueues every root when the DAG has multiple entry points (fan-in to join)', async () => {
    await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: forkWorkflow,
    })

    const nodesInsert = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)
    expect(nodesInsert).toBeDefined()
    const queuedNodeIds = (nodesInsert![1] as Array<{ nodeId: string; status: string }>)
      .filter((row) => row.status === 'queued')
      .map((row) => row.nodeId)
      .sort()
    expect(queuedNodeIds).toEqual(['root_a', 'root_b'])
    expect(enqueueNodeMock).toHaveBeenCalledTimes(2)
    const enqueuedNodeIds = enqueueNodeMock.mock.calls
      .map((call) => (call[0] as { nodeId: string }).nodeId)
      .sort()
    expect(enqueuedNodeIds).toEqual(['root_a', 'root_b'])
    expect(appendEventMock).toHaveBeenCalledTimes(2)
  })

  it('handles a workflow with no nodes by skipping the run_nodes insert', async () => {
    const empty = { dslVersion: '1.0' as const, nodes: [], edges: [] }
    const result = await replayRunAsValidation({
      orgId: 'org-1',
      sourceRunId: 'src-run',
      workflow: empty,
    })

    const nodesInsert = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)
    expect(nodesInsert).toBeUndefined()
    expect(enqueueNodeMock).not.toHaveBeenCalled()
    expect(result.runId).toEqual(expect.any(String))
  })

  it('honors createdBy: null when caller omits it', async () => {
    await replayRunAsValidation({
      orgId: 'org-2',
      sourceRunId: 'src-run',
      workflow: linearWorkflow,
    })

    const runsInsert = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect((runsInsert![1] as { createdBy: string | null }).createdBy).toBeNull()
  })
})
