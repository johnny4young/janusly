import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRuntime } from './runtime'
import type {
  ExecutionStore,
  NodeExecutorRegistry,
  QueueAdapter,
} from './types'

// Mock the data repos the runtime imports so tests don't reach Postgres.
// Each mock returns a benign no-op default; individual tests can override
// per-call via `.mockImplementationOnce()` / `.mockResolvedValueOnce()`
// against the imported reference.
vi.mock('@janusly/data/src/routingStatsRepo', () => ({
  getRoutingStats: vi.fn().mockResolvedValue({}),
  updateRoutingStats: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@janusly/data/src/improvementsRepo', () => ({
  recordWorkflowImprovement: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@janusly/data/src/workflowRollbackRepo', () => ({
  rollbackWorkflowVersion: vi.fn().mockResolvedValue({ rolledBack: true }),
}))

function makeStore(overrides: Partial<ExecutionStore> = {}): ExecutionStore {
  return {
    getRunContext: vi.fn().mockResolvedValue({}),
    getRunStatus: vi.fn().mockResolvedValue('running'),
    // Sensible default — test-org with a workflow + version. Tests that
    // probe the null-metadata branch override this with `mockResolvedValue(null)`.
    getRunMetadata: vi.fn().mockResolvedValue({
      orgId: 'test-org',
      workflowVersionId: 'wv-1',
      workflowId: 'wf-1',
      createdBy: null,
    }),
    getNodeStatus: vi.fn().mockResolvedValue('pending'),
    markNodeQueued: vi.fn().mockImplementation(
      async (_runId, _nodeId, attempt = 1, recoveryClaimToken) => ({
        attempt,
        recoveryClaimToken: recoveryClaimToken ?? null,
        publicationGeneration: 1,
      }),
    ),
    tryClaimNodeForQueue: vi.fn().mockResolvedValue({
      attempt: 1,
      recoveryClaimToken: null,
      publicationGeneration: 1,
    }),
    claimNodeForExecution: vi.fn().mockResolvedValue('claimed'),
    markQueuePublicationSucceeded: vi.fn().mockResolvedValue(true),
    markNodeSucceeded: vi.fn().mockResolvedValue(true),
    markNodeSucceededWithEvent: vi.fn().mockResolvedValue(true),
    markNodeFailed: vi.fn().mockResolvedValue(true),
    markNodeWaiting: vi.fn().mockResolvedValue(true),
    markNodeSkipped: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    updateRunStatusFromNodes: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeQueue(): QueueAdapter {
  return {
    enqueueNode: vi.fn().mockResolvedValue(undefined),
    persistTerminalFailure: vi.fn().mockResolvedValue(true),
    enqueueDeadLetter: vi.fn().mockResolvedValue(undefined),
  }
}

function makeExecutors(result: unknown = { status: 'completed', output: { ok: true } }): NodeExecutorRegistry {
  return {
    execute: vi.fn().mockResolvedValue(result),
  }
}

function makeFailingExecutors(error = new Error('temporary outage')): NodeExecutorRegistry {
  return {
    execute: vi.fn().mockRejectedValue(error),
  }
}

const node = { id: 'n1', type: 'noop' as const, config: {} }
const workflow = { dslVersion: '1.0' as const, nodes: [node], edges: [] }
const input = { runId: 'r1', node, workflow }

describe('executeQueuedNode — cancellation guards', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips a queued job when the run is already cancelled', async () => {
    const store = makeStore({ claimNodeForExecution: vi.fn().mockResolvedValue('run_cancelled') })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).not.toHaveBeenCalled()
    expect(store.claimNodeForExecution).toHaveBeenCalledWith('r1', 'n1', 1, undefined, 0)
  })

  it('skips a queued job when the run has already failed', async () => {
    const store = makeStore({ claimNodeForExecution: vi.fn().mockResolvedValue('run_failed') })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).not.toHaveBeenCalled()
    expect(store.claimNodeForExecution).toHaveBeenCalledWith('r1', 'n1', 1, undefined, 0)
  })

  it('skips when the execution claim finds the node already advanced past queued', async () => {
    const store = makeStore({
      claimNodeForExecution: vi.fn().mockResolvedValue('not_claimed'),
    })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).not.toHaveBeenCalled()
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.skipped',
      payload: expect.objectContaining({ reason: 'Node not in queued state' }),
    }))
  })

  it('runs the executor on the happy path and schedules downstream work', async () => {
    const store = makeStore()
    const executors = makeExecutors({ status: 'completed', output: { x: 1 } })
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(store.claimNodeForExecution).toHaveBeenCalledWith('r1', 'n1', 1, undefined, 0)
    expect(executors.execute).toHaveBeenCalled()
    // The succeeded transition + its node.succeeded event commit together via
    // markNodeSucceededWithEvent (not markNodeSucceeded + a separate appendEvent).
    expect(store.markNodeSucceededWithEvent).toHaveBeenCalledWith('r1', 'n1', { x: 1 }, 1, undefined)
    // appendEvent still fires for node.running (and enqueueReadyNodes events).
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'node.running' }))
  })

  it('stops a stale recovery generation before success events or downstream scheduling', async () => {
    const store = makeStore({
      markNodeSucceededWithEvent: vi.fn().mockResolvedValue(false),
    })
    const queue = makeQueue()
    const executors = makeExecutors({ status: 'completed', output: { stale: true } })
    const runtime = new WorkflowRuntime(store, queue, executors)

    await runtime.executeQueuedNode({ ...input, recoveryClaimToken: 'claim-old' })

    expect(store.claimNodeForExecution).toHaveBeenCalledWith('r1', 'n1', 1, 'claim-old', 0)
    expect(store.markNodeSucceededWithEvent).toHaveBeenCalledWith(
      'r1',
      'n1',
      { stale: true },
      1,
      'claim-old',
    )
    expect(queue.enqueueNode).not.toHaveBeenCalled()
    expect(store.updateRunStatusFromNodes).not.toHaveBeenCalled()
  })

  it('stamps one waitingSince value into persistence and the live event', async () => {
    const store = makeStore()
    const executors = makeExecutors({ status: 'waiting', metadata: { kind: 'approval', title: 'Approve refund' } })
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(store.markNodeWaiting).toHaveBeenCalledWith('r1', 'n1', expect.objectContaining({
      kind: 'approval',
      title: 'Approve refund',
      waitingSince: expect.any(String),
    }), undefined)
    const persistedMetadata = vi.mocked(store.markNodeWaiting).mock.calls[0]?.[2] as { waitingSince: string }
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.waiting',
      payload: expect.objectContaining({
        metadata: expect.objectContaining({ waitingSince: persistedMetadata.waitingSince }),
      }),
    }))
    expect(store.markNodeSucceededWithEvent).not.toHaveBeenCalled()
  })

  it('starts a relative approval deadline from the persisted checkpoint clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'))
    try {
      const store = makeStore()
      const executors = makeExecutors({
        status: 'waiting',
        metadata: { kind: 'approval', decisionTimeoutMs: 60_000, onTimeout: 'fail' },
      })
      const runtime = new WorkflowRuntime(store, makeQueue(), executors)

      await runtime.executeQueuedNode(input)

      expect(store.markNodeWaiting).toHaveBeenCalledWith('r1', 'n1', expect.objectContaining({
        decisionTimeoutMs: 60_000,
        deadlineAt: '2026-07-14T12:01:00.000Z',
        waitingSince: '2026-07-14T12:00:00.000Z',
      }), undefined)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips downstream scheduling when the run is cancelled while a node was running', async () => {
    // First getRunStatus call (pre-execution) returns "running"; the second
    // (post-success, just before enqueueReadyNodes) returns "cancelled".
    const getRunStatus = vi.fn()
      .mockResolvedValueOnce('running')   // pre-execution check
      .mockResolvedValueOnce('cancelled') // post-success check
    const store = makeStore({ getRunStatus })
    const executors = makeExecutors({ status: 'completed', output: { x: 1 } })
    const enqueueNode = vi.fn().mockResolvedValue(undefined)
    const queue: QueueAdapter = {
      enqueueNode,
      persistTerminalFailure: vi.fn().mockResolvedValue(true),
    }
    const runtime = new WorkflowRuntime(store, queue, executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).toHaveBeenCalled()
    expect(store.markNodeSucceededWithEvent).toHaveBeenCalled()
    // enqueueReadyNodes never gets a chance to call queue.enqueueNode
    expect(enqueueNode).not.toHaveBeenCalled()
  })

  it('marks a retried node queued before enqueueing the next attempt', async () => {
    const retryNode = { ...node, config: { retry: { maxAttempts: 2 } } }
    const retryWorkflow = { ...workflow, nodes: [retryNode] }
    const store = makeStore({
      getRunStatus: vi.fn().mockResolvedValue('running'),
    })
    const queue = makeQueue()
    const executors = makeFailingExecutors()
    const runtime = new WorkflowRuntime(store, queue, executors)

    await runtime.executeQueuedNode({ runId: 'r1', node: retryNode, workflow: retryWorkflow })

    expect(store.markNodeQueued).toHaveBeenCalledWith('r1', 'n1', 2, undefined, expect.any(Number))
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.retry',
      payload: expect.objectContaining({ attempt: 2 }),
    }))
    expect(queue.enqueueNode).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      nodeId: 'n1',
      attempt: 2,
    }))
    expect(store.markQueuePublicationSucceeded).toHaveBeenCalledWith('r1', 'n1', 2, 1, undefined)
    expect(store.markNodeFailed).not.toHaveBeenCalled()
  })

  it('does not schedule a retry when cancellation lands during the failed attempt', async () => {
    const retryNode = { ...node, config: { retry: { maxAttempts: 2 } } }
    const retryWorkflow = { ...workflow, nodes: [retryNode] }
    const store = makeStore({
      getRunStatus: vi.fn().mockResolvedValue('cancelled'),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeFailingExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: retryNode, workflow: retryWorkflow })

    expect(store.markNodeQueued).not.toHaveBeenCalled()
    expect(queue.enqueueNode).not.toHaveBeenCalled()
    expect(store.markNodeFailed).not.toHaveBeenCalled()
  })

  it('passes the run orgId into the DLQ row when a node exhausts retries', async () => {
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(makeStore(), queue, makeFailingExecutors())

    await expect(runtime.executeQueuedNode(input)).rejects.toThrow('temporary outage')

    expect(queue.persistTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      orgId: 'test-org',
      workflowId: 'wf-1',
      node,
      attempt: 1,
    }))
  })

  it('does not update routing rewards when a stale generation loses terminal ownership', async () => {
    const { updateRoutingStats } = await import('@janusly/data/src/routingStatsRepo')
    const queue = makeQueue()
    vi.mocked(queue.persistTerminalFailure).mockResolvedValueOnce(false)
    const runtime = new WorkflowRuntime(makeStore(), queue, makeFailingExecutors())

    await expect(runtime.executeQueuedNode({ ...input, recoveryClaimToken: 'stale-claim' }))
      .resolves.toBeUndefined()

    expect(updateRoutingStats).not.toHaveBeenCalled()
    expect(queue.persistTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      recoveryClaimToken: 'stale-claim',
    }))
  })

  it('updates a retry failure reward only after the running-to-queued CAS wins', async () => {
    const { updateRoutingStats } = await import('@janusly/data/src/routingStatsRepo')
    const retryNode = { ...node, config: { retry: { maxAttempts: 2 } } }
    const retryWorkflow = { ...workflow, nodes: [retryNode] }
    const store = makeStore({
      getRunStatus: vi.fn().mockResolvedValue('running'),
      markNodeQueued: vi.fn().mockResolvedValue(false),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeFailingExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: retryNode, workflow: retryWorkflow })

    expect(updateRoutingStats).not.toHaveBeenCalled()
  })
})

describe('executeQueuedNode — router candidate normalization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('normalizes legacy { id } candidates so chosenNodeId is a real string', async () => {
    // Workflow with a router node whose candidates use the legacy `id` field.
    // The runtime must convert these into `{ nodeId }` before the decision
    // engine scores them; otherwise chosenNodeId comes back undefined and the
    // persisted decision is nameless.
    const routerNode = { id: 'pick', type: 'router' as const, config: { candidates: [{ id: 'fast_path' }] } }
    const routerWorkflow = { dslVersion: '1.0' as const, nodes: [routerNode], edges: [] }
    const store = makeStore()
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: routerWorkflow })

    expect(store.markNodeSucceeded).toHaveBeenCalledWith('r1', 'pick', expect.objectContaining({
      decision: expect.objectContaining({
        chosenNodeId: 'fast_path',
        ranking: expect.arrayContaining([expect.objectContaining({ nodeId: 'fast_path' })]),
      }),
    }), undefined)
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'decision.made',
      payload: expect.objectContaining({ chosenNodeId: 'fast_path' }),
    }))
  })

  it('forwards a valid config.strategy to the decision engine so the chosen candidate matches the strategy', async () => {
    // Two candidates differing only in avgLatencyMs. With strategy="fastest"
    // the lower-latency candidate must win; this proves config.strategy is
    // actually plumbed into decide() rather than silently ignored.
    const routerNode = {
      id: 'pick',
      type: 'router' as const,
      config: {
        strategy: 'fastest',
        candidates: [
          { nodeId: 'slow', avgLatencyMs: 1500 },
          { nodeId: 'fast', avgLatencyMs: 200 },
        ],
      },
    }
    const routerWorkflow = { dslVersion: '1.0' as const, nodes: [routerNode], edges: [] }
    const store = makeStore()
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: routerWorkflow })

    expect(store.markNodeSucceeded).toHaveBeenCalledWith('r1', 'pick', expect.objectContaining({
      decision: expect.objectContaining({ chosenNodeId: 'fast' }),
    }), undefined)
  })

  it('preserves scoring fields across mixed-shape candidates so the cheaper one wins under default scoring', async () => {
    // Two candidates: one legacy { id }, one canonical { nodeId }, with
    // different avgCost values. The default score formula penalises higher
    // cost, so the cheap candidate must win — proving both shapes feed into
    // scoring identically and avgCost survives the normaliser.
    const routerNode = {
      id: 'pick',
      type: 'router' as const,
      config: {
        candidates: [
          { id: 'expensive', avgCost: 0.5 },
          { nodeId: 'cheap', avgCost: 0.1 },
        ],
      },
    }
    const routerWorkflow = { dslVersion: '1.0' as const, nodes: [routerNode], edges: [] }
    const store = makeStore()
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: routerWorkflow })

    expect(store.markNodeSucceeded).toHaveBeenCalledWith('r1', 'pick', expect.objectContaining({
      decision: expect.objectContaining({ chosenNodeId: 'cheap' }),
    }), undefined)
  })
})

describe('executeQueuedNode — runtime learning metadata', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards orgId from getRunMetadata into updateRoutingStats on success', async () => {
    // Today's no-op behavior was: orgId pulled from the loose RunContext
    // bag → undefined → repo silently returned. With getRunMetadata, the
    // org-scoped write happens for real on every healthy run.
    const { updateRoutingStats } = await import('@janusly/data/src/routingStatsRepo')
    const store = makeStore({
      getRunMetadata: vi.fn().mockResolvedValue({
        orgId: 'paying-customer',
        workflowVersionId: 'wv-42',
        workflowId: 'wf-42',
        createdBy: 'alice',
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode(input)

    expect(updateRoutingStats).toHaveBeenCalledWith({
      orgId: 'paying-customer',
      nodeId: 'n1',
      reward: 1,
      success: true,
    })
  })

  it('passes the org\'s routing stats as live rlStats into decide()', async () => {
    // Before this wiring landed, rlStats was always undefined — the bandit
    // term in decide() was effectively dead. Verify a router node now sees
    // the org's prior reinforcement counters.
    const { getRoutingStats } = await import('@janusly/data/src/routingStatsRepo')
    ;(getRoutingStats as any).mockResolvedValueOnce({
      fast_path: { nodeId: 'fast_path', pulls: 12, meanReward: 0.8, successCount: 10, failureCount: 2 },
    })

    const routerNode = {
      id: 'pick',
      type: 'router' as const,
      config: { candidates: [{ nodeId: 'fast_path' }] },
    }
    const routerWorkflow = { dslVersion: '1.0' as const, nodes: [routerNode], edges: [] }
    const store = makeStore({
      getRunMetadata: vi.fn().mockResolvedValue({
        orgId: 'org-with-history',
        workflowVersionId: 'wv-1',
        workflowId: 'wf-1',
        createdBy: null,
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: routerWorkflow })

    expect(getRoutingStats).toHaveBeenCalledWith('org-with-history')
    // The decision is computed against rlStats — assert the persisted
    // ranking includes the candidate (proves the call didn't crash on the
    // shape) and that chosenNodeId is real.
    expect(store.markNodeSucceeded).toHaveBeenCalledWith('r1', 'pick', expect.objectContaining({
      decision: expect.objectContaining({ chosenNodeId: 'fast_path' }),
    }), undefined)
  })

  it('records workflow improvement when metadata.workflowId is present', async () => {
    const { recordWorkflowImprovement } = await import('@janusly/data/src/improvementsRepo')
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        // Improvement-eval triggers when the context bag carries metric
        // snapshots. orgId/workflowId no longer matter here — they come
        // from `metadata` now — but the metrics still flow through context.
        metricsBefore: { successRate: 0.6 },
        metricsAfter: { successRate: 0.9 },
      }),
      getRunMetadata: vi.fn().mockResolvedValue({
        orgId: 'org-1',
        workflowVersionId: 'wv-1',
        workflowId: 'wf-1',
        createdBy: null,
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode(input)

    expect(recordWorkflowImprovement).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      workflowId: 'wf-1',
    }))
  })

  it('skips workflow improvement when metadata.workflowId is null (deleted version row)', async () => {
    // Soft race: the workflow_versions row pointed at by runs.workflowVersionId
    // was deleted between scheduling and execution. The leftJoin in
    // getRunMetadata returns null workflowId. Improvement evaluation must
    // no-op gracefully without crashing the run.
    const { recordWorkflowImprovement } = await import('@janusly/data/src/improvementsRepo')
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        metricsBefore: { x: 1 },
        metricsAfter: { x: 2 },
      }),
      getRunMetadata: vi.fn().mockResolvedValue({
        orgId: 'org-1',
        workflowVersionId: 'wv-stale',
        workflowId: null,
        createdBy: null,
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode(input)

    expect(recordWorkflowImprovement).not.toHaveBeenCalled()
    // Run still succeeds — node is marked succeeded; no crash.
    expect(store.markNodeSucceededWithEvent).toHaveBeenCalled()
  })

  it('runs the executor when getRunMetadata returns null (run row deleted mid-flight)', async () => {
    // Defensive: if the runs row vanished between scheduling and worker
    // pickup, metadata-dependent branches no-op but the executor still
    // runs so node-status correctness is preserved.
    const { updateRoutingStats } = await import('@janusly/data/src/routingStatsRepo')
    const store = makeStore({
      getRunMetadata: vi.fn().mockResolvedValue(null),
    })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    // Executor still ran.
    expect(executors.execute).toHaveBeenCalled()
    expect(store.markNodeSucceededWithEvent).toHaveBeenCalled()
    // Routing-stats write was made (the repo's own guard short-circuits on
    // undefined orgId).
    expect(updateRoutingStats).toHaveBeenCalledWith(expect.objectContaining({
      orgId: undefined,
    }))
  })

  it('routes getRunMetadata failures through the node failure lifecycle', async () => {
    // The node has already been claimed and announced as running before
    // metadata is loaded. If the metadata query fails, the runtime must use
    // the same failure/DLQ path as executor errors instead of leaving the
    // node stuck in `running`.
    const metadataError = new Error('metadata query failed')
    const store = makeStore({
      getRunMetadata: vi.fn().mockRejectedValue(metadataError),
    })
    const queue = makeQueue()
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, queue, executors)

    await expect(runtime.executeQueuedNode(input)).rejects.toThrow('metadata query failed')

    expect(executors.execute).not.toHaveBeenCalled()
    expect(queue.persistTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      orgId: 'default',
      node,
      attempt: 1,
      error: expect.objectContaining({ message: 'metadata query failed' }),
    }))
    expect(store.markNodeFailed).not.toHaveBeenCalled()
    expect(store.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'node.failed' }))
    expect(store.updateRunStatusFromNodes).not.toHaveBeenCalled()
  })
})

describe('enqueueReadyNodes — cancellation head guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 0 immediately when the run is cancelled', async () => {
    const store = makeStore({ getRunStatus: vi.fn().mockResolvedValue('cancelled') })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    const queued = await runtime.enqueueReadyNodes({ runId: 'r1', workflow })

    expect(queued).toBe(0)
    expect(store.tryClaimNodeForQueue).not.toHaveBeenCalled()
    expect(queue.enqueueNode).not.toHaveBeenCalled()
  })

  it('returns 0 immediately when the run has failed', async () => {
    const store = makeStore({ getRunStatus: vi.fn().mockResolvedValue('failed') })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    expect(await runtime.enqueueReadyNodes({ runId: 'r1', workflow })).toBe(0)
    expect(store.tryClaimNodeForQueue).not.toHaveBeenCalled()
  })

  it('requeues a pending root restored by the publication reconciler', async () => {
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({ n1: { status: 'pending' } }),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    await expect(runtime.enqueueReadyNodes({ runId: 'r1', workflow })).resolves.toBe(1)
    expect(store.markNodeSkipped).not.toHaveBeenCalled()
    expect(store.tryClaimNodeForQueue).toHaveBeenCalledWith('r1', 'n1', 1)
    expect(queue.enqueueNode).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      nodeId: 'n1',
      publicationGeneration: 1,
    }))
  })
})

describe('enqueueReadyNodes — fan-in (parallel_fork / join)', () => {
  // Three-branch fan-out workflow:  fork → (a, b, c) → merge
  // Lets us pin: the merge only queues when ALL branch predecessors are
  // succeeded; the merge does not queue when even one branch is still
  // pending; and the merge does not queue when one branch terminally
  // failed (the AC's "one branch failing fails the whole join").
  const fanInWorkflow = {
    dslVersion: '1.0' as const,
    nodes: [
      { id: 'fork', type: 'parallel_fork' as const, config: { branches: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] } },
      { id: 'a', type: 'noop' as const, config: {} },
      { id: 'b', type: 'noop' as const, config: {} },
      { id: 'c', type: 'noop' as const, config: {} },
      { id: 'merge', type: 'join' as const, config: { sources: { a: 'a', b: 'b', c: 'c' } } },
    ],
    edges: [
      { from: 'fork', to: 'a' },
      { from: 'fork', to: 'b' },
      { from: 'fork', to: 'c' },
      { from: 'a', to: 'merge' },
      { from: 'b', to: 'merge' },
      { from: 'c', to: 'merge' },
    ],
  }

  beforeEach(() => vi.clearAllMocks())

  it('queues merge exactly once when all branches have succeeded', async () => {
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        fork: { status: 'succeeded' },
        a: { status: 'succeeded' },
        b: { status: 'succeeded' },
        c: { status: 'succeeded' },
        merge: { status: 'pending' },
      }),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    const queued = await runtime.enqueueReadyNodes({ runId: 'r1', workflow: fanInWorkflow })

    expect(queued).toBe(1)
    expect(store.tryClaimNodeForQueue).toHaveBeenCalledWith('r1', 'merge', 1)
    expect(queue.enqueueNode).toHaveBeenCalledTimes(1)
    expect(queue.enqueueNode).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', nodeId: 'merge' }))
  })

  it('does NOT queue merge while one branch is still running (pending fan-in)', async () => {
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        fork: { status: 'succeeded' },
        a: { status: 'succeeded' },
        b: { status: 'succeeded' },
        c: { status: 'running' },
        merge: { status: 'pending' },
      }),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    await runtime.enqueueReadyNodes({ runId: 'r1', workflow: fanInWorkflow })

    expect(store.tryClaimNodeForQueue).not.toHaveBeenCalledWith('r1', 'merge', expect.anything())
    expect(queue.enqueueNode).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'merge' }))
  })

  it('does NOT queue merge when one branch failed terminally (join never runs)', async () => {
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        fork: { status: 'succeeded' },
        a: { status: 'succeeded' },
        b: { status: 'succeeded' },
        c: { status: 'failed' },
        merge: { status: 'pending' },
      }),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    await runtime.enqueueReadyNodes({ runId: 'r1', workflow: fanInWorkflow })

    expect(store.tryClaimNodeForQueue).not.toHaveBeenCalledWith('r1', 'merge', expect.anything())
    expect(queue.enqueueNode).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'merge' }))
  })
})

describe('enqueueReadyNodes — snapshot-based readiness', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads node statuses from one context snapshot, never via per-node getNodeStatus queries', async () => {
    // The measurement behind the optimization: a scan used to issue one
    // getNodeStatus query per dependency edge PLUS one per node (O(nodes +
    // edges) round-trips on every node completion). It must now derive all
    // readiness reads from the single getRunContext snapshot.
    const chain = {
      dslVersion: '1.0' as const,
      nodes: [
        { id: 'a', type: 'noop' as const, config: {} },
        { id: 'b', type: 'noop' as const, config: {} },
        { id: 'c', type: 'noop' as const, config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    }
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        a: { status: 'succeeded' },
        b: { status: 'pending' },
        c: { status: 'pending' },
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    const queued = await runtime.enqueueReadyNodes({ runId: 'r1', workflow: chain })

    expect(queued).toBe(1) // b is ready (a succeeded); c is not (b pending).
    expect(store.getRunContext).toHaveBeenCalledTimes(1)
    expect(store.getNodeStatus).not.toHaveBeenCalled()
  })

  it('a node skipped in this scan unblocks its dependent within the same scan (skip cascade)', async () => {
    // a succeeded → edge with a false condition skips b → c (dep on b, no
    // condition) must still queue in the SAME scan, because nothing external
    // re-triggers a scan after a skip. This pins the in-place snapshot update
    // that preserves the behavior the per-node fresh reads used to provide.
    const cascade = {
      dslVersion: '1.0' as const,
      nodes: [
        { id: 'a', type: 'noop' as const, config: {} },
        { id: 'b', type: 'noop' as const, config: {} },
        { id: 'c', type: 'noop' as const, config: {} },
      ],
      edges: [
        { from: 'a', to: 'b', condition: 'false' },
        { from: 'b', to: 'c' },
      ],
    }
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        a: { status: 'succeeded' },
        b: { status: 'pending' },
        c: { status: 'pending' },
      }),
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeExecutors())

    const queued = await runtime.enqueueReadyNodes({ runId: 'r1', workflow: cascade })

    expect(store.markNodeSkipped).toHaveBeenCalledWith('r1', 'b', { reason: 'Condition not met' })
    expect(queued).toBe(1)
    expect(queue.enqueueNode).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'c' }))
  })
})

describe('executeQueuedNode — router routes the decision (fourth-wave B-02)', () => {
  beforeEach(() => vi.clearAllMocks())

  const routerNode = {
    id: 'pick',
    type: 'router' as const,
    config: {
      strategy: 'fastest',
      candidates: [
        { nodeId: 'slow', avgLatencyMs: 1500 },
        { nodeId: 'fast', avgLatencyMs: 200 },
      ],
    },
  }
  const wiredWorkflow = {
    dslVersion: '1.0' as const,
    nodes: [
      routerNode,
      { id: 'fast', type: 'noop' as const, config: {} },
      { id: 'slow', type: 'noop' as const, config: {} },
    ],
    edges: [
      { from: 'pick', to: 'fast' },
      { from: 'pick', to: 'slow' },
    ],
  }
  const pendingContext = {
    pick: { status: 'running' },
    fast: { status: 'pending' },
    slow: { status: 'pending' },
  }

  it('marks the non-chosen successor candidate skipped so only the winner runs', async () => {
    const store = makeStore({ getRunContext: vi.fn().mockResolvedValue(pendingContext) })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: wiredWorkflow })

    // strategy=fastest → 'fast' wins; 'slow' must be skipped BEFORE the
    // readiness scan (which treats skipped as satisfied for joins).
    expect(store.markNodeSkipped).toHaveBeenCalledWith('r1', 'slow', { reason: 'Router pick chose fast' })
    expect(store.markNodeSkipped).not.toHaveBeenCalledWith('r1', 'fast', expect.anything())
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'slow',
      type: 'node.skipped',
    }))
  })

  it('never skips a candidate that is not wired as a direct successor', async () => {
    const unwiredWorkflow = { ...wiredWorkflow, edges: [{ from: 'pick', to: 'fast' }] }
    const store = makeStore({ getRunContext: vi.fn().mockResolvedValue(pendingContext) })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: unwiredWorkflow })

    // 'slow' has no pick→slow edge — the ROUTER's skip cannot reach it
    // (validation rejects this shape on new saves via
    // router_candidate_not_successor). The readiness scan may still skip the
    // orphan for its own reason; what matters is the router reason never fires.
    expect(store.markNodeSkipped).not.toHaveBeenCalledWith(
      'r1',
      'slow',
      expect.objectContaining({ reason: expect.stringContaining('Router') }),
    )
  })

  it('never flips a candidate that already advanced past pending', async () => {
    const store = makeStore({
      getRunContext: vi.fn().mockResolvedValue({
        ...pendingContext,
        slow: { status: 'succeeded', output: { done: true } },
      }),
    })
    const runtime = new WorkflowRuntime(store, makeQueue(), makeExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: routerNode, workflow: wiredWorkflow })

    expect(store.markNodeSkipped).not.toHaveBeenCalled()
  })
})
