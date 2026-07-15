import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appendEventMock,
  enqueueNodeMock,
  markQueuePublicationSucceededMock,
  claimReplayTransitionMock,
  ReplayNotClaimableError,
  originalRunNodeRowsRef,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  selectWhereMock,
  txInsertMock,
} = vi.hoisted(() => {
  // The real error's shape so the adapter's throw + the test's `instanceof`
  // check agree. Declared in-hoist so the (also-hoisted) persistence mock
  // factory can reference it without a TDZ error.
  class ReplayNotClaimableError extends Error {
    constructor(readonly reason: 'run_not_replayable' | 'node_mid_retry') {
      super(`Replay not claimable: ${reason}`)
      this.name = 'ReplayNotClaimableError'
    }
  }
  return {
    appendEventMock: vi.fn().mockResolvedValue(undefined),
    enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
    markQueuePublicationSucceededMock: vi.fn().mockResolvedValue(true),
    claimReplayTransitionMock: vi.fn().mockResolvedValue({
      recoveryClaimToken: 'claim-token-1',
      publicationGeneration: 1,
    }),
    ReplayNotClaimableError,
    originalRunNodeRowsRef: { current: [] as Array<Record<string, unknown>> },
    runEventsTable: { name: 'runEvents' },
    runNodesTable: { name: 'runNodes' },
    runsTable: { name: 'runs' },
    safePersistPayloadMock: vi.fn((payload: unknown) => payload),
    selectWhereMock: vi.fn(),
    txInsertMock: vi.fn(),
  }
})

vi.mock('@janusly/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          selectWhereMock(condition)
          return Promise.resolve(originalRunNodeRowsRef.current)
        },
      }),
    }),
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

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}))

vi.mock('../queue', () => ({
  enqueueNode: enqueueNodeMock,
}))

vi.mock('../persistence', () => ({
  markQueuePublicationSucceeded: markQueuePublicationSucceededMock,
  claimReplayTransition: claimReplayTransitionMock,
  appendEvent: appendEventMock,
  ReplayNotClaimableError,
}))

vi.mock('../safe-persist', () => ({
  safePersistPayload: safePersistPayloadMock,
}))

import { DLQReplayAdapter } from './dlq-replay'

const adapter = new DLQReplayAdapter()

const baseWorkflow = {
  dslVersion: '1.0' as const,
  nodes: [
    { id: 'fetch', type: 'http' as const, config: { url: 'https://x.example', method: 'GET' } },
    { id: 'finish', type: 'noop' as const, config: {} },
  ],
  edges: [{ from: 'fetch', to: 'finish' }],
}

const failingNode = baseWorkflow.nodes[0]

beforeEach(() => {
  originalRunNodeRowsRef.current = []
  selectWhereMock.mockReset()
  txInsertMock.mockReset()
  enqueueNodeMock.mockReset()
  markQueuePublicationSucceededMock.mockReset().mockResolvedValue(true)
  claimReplayTransitionMock.mockReset().mockResolvedValue({
    recoveryClaimToken: 'claim-token-1',
    publicationGeneration: 1,
  })
  appendEventMock.mockReset()
})

describe('DLQReplayAdapter.replayDeadLetter (production replay)', () => {
  it('atomically claims the replay transition, snapshots, then enqueues (attempt=1)', async () => {
    await adapter.replayDeadLetter({
      runId: 'orig-run',
      workflow: baseWorkflow,
      node: failingNode,
    })

    expect(enqueueNodeMock).toHaveBeenCalledTimes(1)
    expect(enqueueNodeMock.mock.calls[0][0]).toMatchObject({
      runId: 'orig-run',
      nodeId: failingNode.id,
      attempt: 1,
      recoveryClaimToken: 'claim-token-1',
    })
    // One atomic transition un-terminates the run + re-queues the failed node,
    // replacing the non-atomic resetRunForReplay + markNodeQueued pair whose
    // gap let a cancel land between them.
    expect(claimReplayTransitionMock).toHaveBeenCalledWith('orig-run', failingNode.id, {
      deadLetterId: null,
      recoveryActorId: null,
      recoveryPlaybookId: null,
      recoveryValidationRunId: null,
    }, baseWorkflow)
    expect(markQueuePublicationSucceededMock)
      .toHaveBeenCalledWith('orig-run', failingNode.id, 1, 1, 'claim-token-1')
    // Production replay is a single enqueue — no new run row, no new node rows.
    expect(txInsertMock).not.toHaveBeenCalled()
  })

  it('carries the DLQ recovery claim and initiating actor into the node transition', async () => {
    await adapter.replayDeadLetter({
      runId: 'orig-run',
      workflow: baseWorkflow,
      node: failingNode,
      deadLetterId: 'dlq-1',
      recoveryActorId: 'operator-1',
    })

    expect(claimReplayTransitionMock).toHaveBeenCalledWith('orig-run', failingNode.id, {
      deadLetterId: 'dlq-1',
      recoveryActorId: 'operator-1',
      recoveryPlaybookId: null,
      recoveryValidationRunId: null,
    }, baseWorkflow)
  })

  it('binds a verified playbook and validation run to the replay generation', async () => {
    await adapter.replayDeadLetter({
      runId: 'orig-run',
      workflow: baseWorkflow,
      node: failingNode,
      deadLetterId: 'dlq-1',
      recoveryActorId: 'operator-1',
      recoveryPlaybookId: 'playbook-1',
      recoveryValidationRunId: 'validation-1',
    })

    expect(claimReplayTransitionMock).toHaveBeenCalledWith('orig-run', failingNode.id, {
      deadLetterId: 'dlq-1',
      recoveryActorId: 'operator-1',
      recoveryPlaybookId: 'playbook-1',
      recoveryValidationRunId: 'validation-1',
    }, baseWorkflow)
  })

  it('atomically claims with the snapshot before enqueueing — a rejected claim mutates nothing', async () => {
    claimReplayTransitionMock.mockRejectedValueOnce(new ReplayNotClaimableError('node_mid_retry'))

    await expect(adapter.replayDeadLetter({ runId: 'orig-run', workflow: baseWorkflow, node: failingNode }))
      .rejects.toBeInstanceOf(ReplayNotClaimableError)

    expect(claimReplayTransitionMock).toHaveBeenCalledWith('orig-run', failingNode.id, {
      deadLetterId: null,
      recoveryActorId: null,
      recoveryPlaybookId: null,
      recoveryValidationRunId: null,
    }, baseWorkflow)
    expect(enqueueNodeMock).not.toHaveBeenCalled()
  })
})

describe('DLQReplayAdapter.replayDeadLetterAsValidation (sandbox replay)', () => {
  it('creates a new run with replayMode="validation" and enqueues only the failing node', async () => {
    const result = await adapter.replayDeadLetterAsValidation({
      orgId: 'org-1',
      originalRunId: 'orig-run',
      suggestedWorkflow: baseWorkflow,
      failingNode,
      createdBy: 'user-1',
    })

    expect(result.runId).toEqual(expect.any(String))

    // One runs insert with the validation tag.
    const runsInsertCalls = txInsertMock.mock.calls.filter((args) => args[0] === runsTable)
    expect(runsInsertCalls).toHaveLength(1)
    expect(runsInsertCalls[0][1]).toMatchObject({
      id: result.runId,
      orgId: 'org-1',
      replayMode: 'validation',
      // Synthetic version id mirrors the ad-hoc-run pattern: the runs row
      // doesn't point at a real workflow_versions row so the suggested
      // workflow stays sandbox-only.
      workflowVersionId: result.runId,
      // Original failing run linkage for traceability.
      parentRunId: 'orig-run',
      parentNodeId: null,
      status: 'running',
      createdBy: 'user-1',
    })

    // The failing generation and its durable publication marker commit with
    // the run; downstream nodes remain pending.
    const runNodesInsertCalls = txInsertMock.mock.calls.filter((args) => args[0] === runNodesTable)
    expect(runNodesInsertCalls).toHaveLength(1)
    expect(runNodesInsertCalls[0][1]).toHaveLength(2)
    const rows = runNodesInsertCalls[0][1] as Array<{
      nodeId: string
      status: string
      attempts: number
      queuePublicationRepairAfter: Date | null
      queuePublicationGeneration: number
    }>
    const nodeIds = rows.map((row) => row.nodeId).sort()
    expect(nodeIds).toEqual(['fetch', 'finish'])
    expect(rows.find((row) => row.nodeId === 'fetch')).toMatchObject({
      status: 'queued',
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    })
    expect(rows.find((row) => row.nodeId === 'finish')).toMatchObject({
      status: 'pending',
      attempts: 0,
      queuePublicationRepairAfter: null,
      queuePublicationGeneration: 0,
    })

    // The failing node specifically is published from its atomic DB claim.
    expect(enqueueNodeMock).toHaveBeenCalledTimes(1)
    expect(enqueueNodeMock.mock.calls[0][0]).toMatchObject({
      runId: result.runId,
      nodeId: 'fetch',
      attempt: 1,
    })
    expect(markQueuePublicationSucceededMock).toHaveBeenCalledWith(result.runId, 'fetch', 1, 1)

    // Sandbox start event so the timeline distinguishes it from production runs.
    const eventInsertCalls = txInsertMock.mock.calls.filter((args) => args[0] === runEventsTable)
    expect(eventInsertCalls).toHaveLength(1)
    expect(eventInsertCalls[0][1]).toMatchObject({
      runId: result.runId,
      type: 'run.started.validation',
    })
  })

  it('persists the suggested workflow + failing node id in inputJson', async () => {
    await adapter.replayDeadLetterAsValidation({
      orgId: 'org-1',
      originalRunId: 'orig-run',
      suggestedWorkflow: baseWorkflow,
      failingNode,
    })

    const runsInsertCall = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect(runsInsertCall).toBeDefined()
    expect((runsInsertCall![1] as { inputJson: { workflow: unknown; failingNodeId: string } }).inputJson).toEqual({
      workflow: baseWorkflow,
      failingNodeId: 'fetch',
    })
  })

  it('attests an explicit Recovery Playbook use in the validation run and start event', async () => {
    await adapter.replayDeadLetterAsValidation({
      orgId: 'org-1',
      originalRunId: 'orig-run',
      suggestedWorkflow: baseWorkflow,
      failingNode,
      recoveryPlaybookId: 'playbook-1',
    })

    const runsInsertCall = txInsertMock.mock.calls.find((args) => args[0] === runsTable)
    expect(runsInsertCall?.[1]).toMatchObject({
      inputJson: { workflow: baseWorkflow, failingNodeId: 'fetch', recoveryPlaybookId: 'playbook-1' },
    })
    const eventInsertCall = txInsertMock.mock.calls.find((args) => args[0] === runEventsTable)
    expect(eventInsertCall?.[1]).toMatchObject({
      payload: expect.objectContaining({ recoveryPlaybookId: 'playbook-1' }),
    })
  })

  it('copies terminal ancestor context from the original run into the validation run', async () => {
    const workflow = {
      dslVersion: '1.0' as const,
      nodes: [
        { id: 'load_customer', type: 'http' as const, config: { url: 'https://x.example/customer', method: 'GET' } },
        { id: 'repair_target', type: 'http' as const, config: { url: '{{context.load_customer.output.url}}', method: 'GET' } },
        { id: 'notify', type: 'noop' as const, config: {} },
      ],
      edges: [
        { from: 'load_customer', to: 'repair_target' },
        { from: 'repair_target', to: 'notify' },
      ],
    }
    const target = workflow.nodes[1]!
    originalRunNodeRowsRef.current = [
      {
        nodeId: 'load_customer',
        status: 'succeeded',
        stateJson: { output: { url: 'https://api.example/customer/123' } },
        attempts: 1,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: new Date('2026-01-01T00:00:01.000Z'),
        errorJson: null,
      },
      {
        nodeId: 'repair_target',
        status: 'failed',
        stateJson: {},
        attempts: 1,
        startedAt: new Date('2026-01-01T00:00:02.000Z'),
        finishedAt: new Date('2026-01-01T00:00:03.000Z'),
        errorJson: { message: 'bad target' },
      },
    ]

    await adapter.replayDeadLetterAsValidation({
      orgId: 'org-1',
      originalRunId: 'orig-run',
      suggestedWorkflow: workflow,
      failingNode: target,
    })

    const runNodesInsertCall = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)
    const rows = runNodesInsertCall?.[1] as Array<{ nodeId: string; status: string; stateJson: unknown; errorJson: unknown }>
    const ancestor = rows.find((row) => row.nodeId === 'load_customer')
    const failedNode = rows.find((row) => row.nodeId === 'repair_target')
    const downstream = rows.find((row) => row.nodeId === 'notify')

    expect(ancestor).toMatchObject({
      status: 'succeeded',
      stateJson: { output: { url: 'https://api.example/customer/123' } },
      errorJson: null,
    })
    expect(failedNode).toMatchObject({
      status: 'queued',
      stateJson: {},
      errorJson: null,
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    })
    expect(downstream).toMatchObject({ status: 'pending', stateJson: {}, errorJson: null })
  })

  it('skips non-terminal ancestors and unrelated roots outside the validation path', async () => {
    const workflow = {
      dslVersion: '1.0' as const,
      nodes: [
        { id: 'trigger', type: 'webhook' as const, config: {} },
        { id: 'repair_target', type: 'noop' as const, config: {} },
        { id: 'downstream', type: 'noop' as const, config: {} },
        { id: 'unrelated_root', type: 'noop' as const, config: {} },
      ],
      edges: [
        { from: 'trigger', to: 'repair_target' },
        { from: 'repair_target', to: 'downstream' },
      ],
    }
    const target = workflow.nodes[1]!
    originalRunNodeRowsRef.current = [
      {
        nodeId: 'trigger',
        status: 'waiting',
        stateJson: { waiting: { kind: 'webhook' } },
        attempts: 1,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: null,
        errorJson: null,
      },
      {
        nodeId: 'repair_target',
        status: 'failed',
        stateJson: {},
        attempts: 1,
        startedAt: new Date('2026-01-01T00:00:01.000Z'),
        finishedAt: new Date('2026-01-01T00:00:02.000Z'),
        errorJson: { message: 'repair me' },
      },
    ]

    await adapter.replayDeadLetterAsValidation({
      orgId: 'org-1',
      originalRunId: 'orig-run',
      suggestedWorkflow: workflow,
      failingNode: target,
    })

    const runNodesInsertCall = txInsertMock.mock.calls.find((args) => args[0] === runNodesTable)
    const rows = runNodesInsertCall?.[1] as Array<{
      nodeId: string
      status: string
      stateJson: unknown
      finishedAt: Date | null
    }>
    expect(rows.find((row) => row.nodeId === 'trigger')).toMatchObject({
      status: 'skipped',
      stateJson: { skipped: { reason: 'outside_validation_path', failingNodeId: 'repair_target' } },
      finishedAt: expect.any(Date),
    })
    expect(rows.find((row) => row.nodeId === 'unrelated_root')).toMatchObject({
      status: 'skipped',
      stateJson: { skipped: { reason: 'outside_validation_path', failingNodeId: 'repair_target' } },
      finishedAt: expect.any(Date),
    })
    expect(rows.find((row) => row.nodeId === 'repair_target')).toMatchObject({ status: 'queued' })
    expect(rows.find((row) => row.nodeId === 'downstream')).toMatchObject({ status: 'pending' })
  })
})
