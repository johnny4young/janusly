import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@janusly/shared'

const {
  appendEventMock,
  enqueueNodeMock,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  txInsertMock,
  updateRunStatusFromNodesMock,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
  runEventsTable: { name: 'runEvents' },
  runNodesTable: { name: 'runNodes' },
  runsTable: { name: 'runs' },
  safePersistPayloadMock: vi.fn((payload: unknown) => payload),
  txInsertMock: vi.fn(),
  updateRunStatusFromNodesMock: vi.fn().mockResolvedValue('succeeded'),
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
  updateRunStatusFromNodes: updateRunStatusFromNodesMock,
}))

vi.mock('../safe-persist', () => ({
  safePersistPayload: safePersistPayloadMock,
}))

import { startSandboxRun } from './sandbox-run'

const linearWorkflow = {
  dslVersion: '1.0',
  nodes: [
    { id: 'trigger', type: 'webhook', config: {} },
    { id: 'notify', type: 'noop', config: {} },
  ],
  edges: [{ from: 'trigger', to: 'notify' }],
} as Workflow

beforeEach(() => {
  txInsertMock.mockReset()
  enqueueNodeMock.mockReset()
  appendEventMock.mockReset()
  updateRunStatusFromNodesMock.mockReset()
  updateRunStatusFromNodesMock.mockResolvedValue('succeeded')
})

describe('startSandboxRun', () => {
  it('seeds root triggers as succeeded and queues direct successors', async () => {
    const input = { alertId: 'alert-1' }
    const result = await startSandboxRun({
      orgId: 'org-1',
      workflow: linearWorkflow,
      input,
      createdBy: 'user-1',
      source: 'pack:incident-triage',
    })

    const runsInsert = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect(runsInsert).toBeDefined()
    expect(runsInsert![1]).toMatchObject({
      id: result.runId,
      orgId: 'org-1',
      replayMode: 'validation',
      workflowVersionId: result.runId,
      parentRunId: null,
      status: 'running',
      createdBy: 'user-1',
    })

    const nodeRows = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)?.[1] as Array<{
      nodeId: string
      status: string
      stateJson: unknown
    }>
    expect(nodeRows).toHaveLength(2)
    expect(nodeRows.find((row) => row.nodeId === 'trigger')).toMatchObject({
      status: 'succeeded',
      stateJson: { output: input },
    })
    expect(nodeRows.find((row) => row.nodeId === 'notify')).toMatchObject({
      status: 'queued',
      stateJson: {},
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    })

    expect(appendEventMock).toHaveBeenCalledWith(result.runId, 'trigger', 'node.completed', {
      output: input,
      sandboxTrigger: true,
    })
    expect(enqueueNodeMock).toHaveBeenCalledWith({
      runId: result.runId,
      nodeId: linearWorkflow.nodes[1].id,
      attempt: 1,
      publicationGeneration: 1,
    })
    expect(updateRunStatusFromNodesMock).not.toHaveBeenCalled()
  })

  it('finalizes root-only workflows so sandbox samples do not stay running forever', async () => {
    const rootOnlyWorkflow = {
      dslVersion: '1.0',
      nodes: [{ id: 'trigger', type: 'webhook', config: {} }],
      edges: [],
    } as Workflow

    const result = await startSandboxRun({
      orgId: 'org-1',
      workflow: rootOnlyWorkflow,
      input: { ticketId: 'ticket-1' },
    })

    expect(enqueueNodeMock).not.toHaveBeenCalled()
    expect(updateRunStatusFromNodesMock).toHaveBeenCalledWith(result.runId)
  })

  it('queues a join only when every predecessor was seeded as a root', async () => {
    const fanInWorkflow = {
      dslVersion: '1.0',
      nodes: [
        { id: 'email', type: 'webhook', config: {} },
        { id: 'slack', type: 'webhook', config: {} },
        { id: 'join', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'email', to: 'join' },
        { from: 'slack', to: 'join' },
      ],
    } as Workflow

    const result = await startSandboxRun({
      orgId: 'org-1',
      workflow: fanInWorkflow,
    })

    const nodeRows = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)?.[1] as Array<{
      nodeId: string
      status: string
    }>
    expect(nodeRows.find((row) => row.nodeId === 'join')?.status).toBe('queued')
    expect(enqueueNodeMock.mock.calls[0][0]).toMatchObject({
      runId: result.runId,
      nodeId: fanInWorkflow.nodes[2].id,
      attempt: 1,
    })
    expect(updateRunStatusFromNodesMock).not.toHaveBeenCalled()
  })
})
