import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRuntime } from './runtime'
import type {
  ExecutionStore,
  NodeExecutorRegistry,
  QueueAdapter,
} from './types'

vi.mock('./improvementEngine', () => ({
  recordWorkflowImprovement: vi.fn().mockResolvedValue(undefined),
  rollbackToVersion: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../routing', () => ({
  updateRoutingStats: vi.fn().mockResolvedValue(undefined),
}))

function makeStore(overrides: Partial<ExecutionStore> = {}): ExecutionStore {
  return {
    getRunContext: vi.fn().mockResolvedValue({}),
    getRunStatus: vi.fn().mockResolvedValue('running'),
    getNodeStatus: vi.fn().mockResolvedValue('pending'),
    markNodeQueued: vi.fn().mockResolvedValue(undefined),
    tryClaimNodeForQueue: vi.fn().mockResolvedValue(true),
    markNodeRunning: vi.fn().mockResolvedValue(true),
    markNodeSucceeded: vi.fn().mockResolvedValue(undefined),
    markNodeFailed: vi.fn().mockResolvedValue(undefined),
    markNodeWaiting: vi.fn().mockResolvedValue(undefined),
    markNodeSkipped: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    updateRunStatusFromNodes: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeQueue(): QueueAdapter {
  return {
    enqueueNode: vi.fn().mockResolvedValue(undefined),
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
    const store = makeStore({ getRunStatus: vi.fn().mockResolvedValue('cancelled') })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(store.markNodeRunning).not.toHaveBeenCalled()
    expect(executors.execute).not.toHaveBeenCalled()
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.skipped',
      payload: expect.objectContaining({ reason: 'Run cancelled' }),
    }))
  })

  it('skips a queued job when the run has already failed', async () => {
    const store = makeStore({ getRunStatus: vi.fn().mockResolvedValue('failed') })
    const executors = makeExecutors()
    const runtime = new WorkflowRuntime(store, makeQueue(), executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).not.toHaveBeenCalled()
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.skipped',
      payload: expect.objectContaining({ reason: 'Run failed' }),
    }))
  })

  it('skips when markNodeRunning fails to claim the node (already advanced past queued)', async () => {
    const store = makeStore({
      getRunStatus: vi.fn().mockResolvedValue('running'),
      markNodeRunning: vi.fn().mockResolvedValue(false),
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

    expect(store.markNodeRunning).toHaveBeenCalledWith('r1', 'n1', 1)
    expect(executors.execute).toHaveBeenCalled()
    expect(store.markNodeSucceeded).toHaveBeenCalledWith('r1', 'n1', { x: 1 })
    // appendEvent fires for node.running, node.succeeded, plus enqueueReadyNodes events.
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'node.running' }))
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'node.succeeded' }))
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
    const queue: QueueAdapter = { enqueueNode }
    const runtime = new WorkflowRuntime(store, queue, executors)

    await runtime.executeQueuedNode(input)

    expect(executors.execute).toHaveBeenCalled()
    expect(store.markNodeSucceeded).toHaveBeenCalled()
    // enqueueReadyNodes never gets a chance to call queue.enqueueNode
    expect(enqueueNode).not.toHaveBeenCalled()
  })

  it('marks a retried node queued before enqueueing the next attempt', async () => {
    const retryNode = { ...node, config: { retry: { maxAttempts: 2 } } }
    const retryWorkflow = { ...workflow, nodes: [retryNode] }
    const store = makeStore({
      getRunStatus: vi.fn()
        .mockResolvedValueOnce('running') // pre-execution check
        .mockResolvedValueOnce('running'), // retry scheduling check
    })
    const queue = makeQueue()
    const executors = makeFailingExecutors()
    const runtime = new WorkflowRuntime(store, queue, executors)

    await runtime.executeQueuedNode({ runId: 'r1', node: retryNode, workflow: retryWorkflow })

    expect(store.markNodeQueued).toHaveBeenCalledWith('r1', 'n1', 2)
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node.retry',
      payload: expect.objectContaining({ attempt: 2 }),
    }))
    expect(queue.enqueueNode).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'r1',
      node: retryNode,
      attempt: 2,
    }))
    expect(store.markNodeFailed).not.toHaveBeenCalled()
  })

  it('does not schedule a retry when cancellation lands during the failed attempt', async () => {
    const retryNode = { ...node, config: { retry: { maxAttempts: 2 } } }
    const retryWorkflow = { ...workflow, nodes: [retryNode] }
    const store = makeStore({
      getRunStatus: vi.fn()
        .mockResolvedValueOnce('running') // pre-execution check
        .mockResolvedValueOnce('cancelled'), // retry scheduling check
    })
    const queue = makeQueue()
    const runtime = new WorkflowRuntime(store, queue, makeFailingExecutors())

    await runtime.executeQueuedNode({ runId: 'r1', node: retryNode, workflow: retryWorkflow })

    expect(store.markNodeQueued).not.toHaveBeenCalled()
    expect(queue.enqueueNode).not.toHaveBeenCalled()
    expect(store.markNodeFailed).not.toHaveBeenCalled()
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
    }))
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
    }))
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
    }))
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
})
