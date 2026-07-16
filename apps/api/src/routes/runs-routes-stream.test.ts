/** Route-level coverage for bounded, gap-free live-run stream catch-up. */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  addSubscriberMock,
  eqMock,
  getOrgConfigSnapshotMock,
  limitMock,
  removeSubscriberMock,
  selectMock,
  sendEventFrameMock,
  sendErrorMock,
  sendSseCommentMock,
} = vi.hoisted(() => ({
  addSubscriberMock: vi.fn(),
  eqMock: vi.fn((left: unknown, right: unknown) => ({ kind: 'eq', left, right })),
  getOrgConfigSnapshotMock: vi.fn(),
  limitMock: vi.fn(),
  removeSubscriberMock: vi.fn(),
  selectMock: vi.fn(),
  sendEventFrameMock: vi.fn(),
  sendErrorMock: vi.fn(),
  sendSseCommentMock: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
  asc: vi.fn((value: unknown) => ({ kind: 'asc', value })),
  desc: vi.fn((value: unknown) => ({ kind: 'desc', value })),
  eq: eqMock,
  gt: vi.fn((left: unknown, right: unknown) => ({ kind: 'gt', left, right })),
  isNull: vi.fn((value: unknown) => ({ kind: 'isNull', value })),
  lt: vi.fn((left: unknown, right: unknown) => ({ kind: 'lt', left, right })),
  or: vi.fn((...conditions: unknown[]) => ({ kind: 'or', conditions })),
  sql: vi.fn(() => 'resolved-workflow-id'),
}))

vi.mock('@janusly/data', () => ({
  getOrgConfigSnapshot: getOrgConfigSnapshotMock,
  getRunComparison: vi.fn(),
  getWorkflowStatus: vi.fn(),
  WORKFLOW_STATUS_ACTIVE: 'active',
}))

vi.mock('@janusly/db', () => ({
  db: { select: selectMock },
  runEvents: { id: 'run_events.id', runId: 'run_events.run_id', createdAt: 'run_events.created_at' },
  runNodes: {},
  runs: {
    id: 'runs.id',
    orgId: 'runs.org_id',
    workflowVersionId: 'runs.workflow_version_id',
    status: 'runs.status',
    outputJson: 'runs.output_json',
    parentRunId: 'runs.parent_run_id',
    parentNodeId: 'runs.parent_node_id',
    traceId: 'runs.trace_id',
    replayMode: 'runs.replay_mode',
    createdBy: 'runs.created_by',
    createdAt: 'runs.created_at',
    inputJson: 'runs.input_json',
  },
  workflows: {},
  workflowVersions: {
    id: 'workflow_versions.id',
    orgId: 'workflow_versions.org_id',
    workflowId: 'workflow_versions.workflow_id',
  },
}))

vi.mock('@janusly/domain', () => ({ replayDecision: vi.fn() }))
vi.mock('@janusly/engine/src/adapters/redrive', () => ({ redriveRun: vi.fn() }));
vi.mock('@janusly/engine/src/adapters/replay-lab', () => ({
  replayRunAsValidation: vi.fn(),
  replayRunAsValidationFork: vi.fn(),
}))
vi.mock('@janusly/engine/src/inputs-validator', () => ({
  WorkflowInputValidationError: class WorkflowInputValidationError extends Error {},
}))
vi.mock('@janusly/engine/src/persistence', () => ({ cancelRun: vi.fn() }))
vi.mock('@janusly/engine/src/resume-run', () => ({
  ResumeRunConflictError: class ResumeRunConflictError extends Error {},
  resumeRun: vi.fn(),
}))
vi.mock('@janusly/engine/src/start-run', () => ({ startRun: vi.fn() }))
vi.mock('@janusly/engine/src/workflow-readiness', () => ({ checkWorkflowReadiness: vi.fn() }))
vi.mock('@janusly/engine/src/workflow-validation', () => ({ validateWorkflow: vi.fn() }))
vi.mock('../ai-runtime', () => ({
  decisionCandidatesFromPayload: vi.fn(),
  orgLlmRuntime: vi.fn(),
  sanitizeAiWorkflow: vi.fn(),
}))
vi.mock('../audit-helper', () => ({ auditAction: vi.fn() }))
vi.mock('../http', () => ({
  asRecord: vi.fn(value => value),
  corsHeaders: vi.fn(() => ({})),
  readJson: vi.fn(),
  sendEventFrame: sendEventFrameMock,
  sendError: sendErrorMock,
  sendJson: vi.fn(),
  sendSseComment: sendSseCommentMock,
}))
vi.mock('../mcp-consent', () => ({ guardMcpWrite: vi.fn() }))
vi.mock('../rate-limit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('../readiness-helpers', () => ({
  checkRollbackAvailability: vi.fn(),
  getCredentialReadinessIssues: vi.fn(),
  mergeReadiness: vi.fn(),
  productionSecretRefResolver: vi.fn(),
}))
vi.mock('../run-stream', () => ({
  getRunStreamHub: vi.fn(() => ({ addSubscriber: addSubscriberMock })),
}))

import { runsRoutes } from './runs-routes'

const auth = {
  orgId: 'org-1',
  userId: 'user-1',
  mode: 'dev-headers' as const,
  source: 'dev' as const,
}

function streamRoute() {
  const route = runsRoutes.find(candidate => candidate.method === 'GET'
    && typeof candidate.match === 'function'
    && candidate.match('/runs/run-1/stream'))
  if (!route) throw new Error('GET /runs/:runId/stream route not found')
  return route
}

function request(lastEventId?: string) {
  const req = Object.assign(new EventEmitter(), {
    url: '/runs/run-1/stream',
    headers: lastEventId ? { 'last-event-id': lastEventId } : {},
  })
  return {
    req,
    close: () => req.emit('close'),
  }
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    headersSent: false,
    writeHead: vi.fn(() => { res.headersSent = true }),
    write: vi.fn(() => true),
    end: vi.fn(() => { res.writableEnded = true }),
  })
  return res
}

type CatchupRow = {
  id: string
  runId: string
  nodeId: string | null
  type: string
  payload: Record<string, unknown>
  createdAt: Date
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function arrangeRun(
  status: string,
  catchupRows: CatchupRow[] | Promise<CatchupRow[]> = [],
  latestStatus = status,
) {
  let initialWhere: unknown
  selectMock.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(async (condition: unknown) => {
        initialWhere = condition
        return [{ status }]
      }),
    })),
  })
  limitMock.mockReturnValueOnce(catchupRows)
  selectMock.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: limitMock })),
      })),
    })),
  })
  selectMock.mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(async () => [{ status: latestStatus }]) })),
  })
  return { getInitialWhere: () => initialWhere }
}

beforeEach(() => {
  vi.useFakeTimers()
  selectMock.mockReset()
  eqMock.mockClear()
  limitMock.mockReset()
  sendEventFrameMock.mockReset()
  sendEventFrameMock.mockReturnValue(true)
  sendErrorMock.mockReset()
  sendSseCommentMock.mockReset()
  sendSseCommentMock.mockReturnValue(true)
  removeSubscriberMock.mockReset()
  addSubscriberMock.mockReset()
  addSubscriberMock.mockReturnValue({ ok: true, ready: Promise.resolve(), remove: removeSubscriberMock })
  getOrgConfigSnapshotMock.mockResolvedValue({ runs: { streamMaxSubscriptions: 50 } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /runs/:runId/stream protocol', () => {
  it('emits the current run status on every completed connection handshake', async () => {
    arrangeRun('running')
    const { req, close } = request()
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(sendEventFrameMock).toHaveBeenCalledWith(res, {
      event: 'run-status',
      data: { kind: 'run.status', status: 'running' },
    })
    close()
  })

  it('reads one sentinel row, signals truncation, and closes before joining the live tail', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `event-${String(index).padStart(3, '0')}`,
      runId: 'run-1',
      nodeId: 'node-1',
      type: 'node.running',
      payload: {},
      createdAt: new Date(Date.UTC(2026, 6, 13, 0, 0, index)),
    }))
    arrangeRun('running', rows)
    const { req } = request('2026-07-12T23:59:59.000Z|event-old')
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(limitMock).toHaveBeenCalledWith(501)
    expect(sendEventFrameMock.mock.calls.filter(([, frame]) => frame.event === 'run-event')).toHaveLength(500)
    expect(sendEventFrameMock).toHaveBeenLastCalledWith(res, {
      event: 'catchup-truncated',
      data: { kind: 'catchup-truncated', replayed: 500 },
    })
    expect(sendEventFrameMock.mock.calls.some(([, frame]) => frame.event === 'run-status')).toBe(false)
    expect(removeSubscriberMock).toHaveBeenCalledOnce()
    expect(res.end).toHaveBeenCalledOnce()
  })

  it('replays a complete gap before publishing the status snapshot', async () => {
    const rows = [0, 1].map(index => ({
      id: `event-${index}`,
      runId: 'run-1',
      nodeId: 'node-1',
      type: 'node.running',
      payload: {},
      createdAt: new Date(Date.UTC(2026, 6, 13, 0, 0, index)),
    }))
    arrangeRun('running', rows)
    const { req, close } = request('2026-07-12T23:59:59.000Z|event-old')
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(sendEventFrameMock.mock.calls.map(([, frame]) => frame.event)).toEqual([
      'run-event',
      'run-event',
      'run-status',
    ])
    close()
  })

  it('waits for Redis subscription readiness before taking the catch-up snapshot', async () => {
    arrangeRun('running')
    const readiness = deferred<undefined>()
    addSubscriberMock.mockReturnValue({ ok: true, ready: readiness.promise, remove: removeSubscriberMock })
    const { req, close } = request()
    const res = response()

    const handling = streamRoute().handler({ req: req as never, res: res as never, auth })
    await flushMicrotasks()

    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(limitMock).not.toHaveBeenCalled()

    readiness.resolve(undefined)
    await handling
    expect(limitMock).toHaveBeenCalledWith(501)
    close()
  })

  it('returns a typed 503 before SSE headers when Redis subscription fails', async () => {
    arrangeRun('running')
    addSubscriberMock.mockReturnValue({
      ok: true,
      ready: Promise.reject(new Error('redis unavailable')),
      remove: removeSubscriberMock,
    })
    const { req } = request()
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(res.headersSent).toBe(false)
    expect(limitMock).not.toHaveBeenCalled()
    expect(removeSubscriberMock).toHaveBeenCalledOnce()
    expect(sendErrorMock).toHaveBeenCalledWith(
      res,
      'stream_unavailable',
      'Live run stream is unavailable',
      503,
    )
  })

  it('buffers a live publication during deferred catch-up and emits it after the database gap', async () => {
    const catchup = deferred<CatchupRow[]>()
    arrangeRun('running', catchup.promise)
    let publish: ((event: { kind: 'event'; id: string; nodeId: string; type: string; payload: Record<string, unknown>; createdAt: string }) => void) | undefined
    addSubscriberMock.mockImplementation((_runId, _orgId, writer) => {
      publish = writer
      return { ok: true, ready: Promise.resolve(), remove: removeSubscriberMock }
    })
    const { req, close } = request('2026-07-12T23:59:59.000Z|event-old')
    const res = response()

    const handling = streamRoute().handler({ req: req as never, res: res as never, auth })
    await flushMicrotasks()
    publish?.({
      kind: 'event',
      id: 'event-live',
      nodeId: 'node-live',
      type: 'node.succeeded',
      payload: {},
      createdAt: '2026-07-13T00:00:02.000Z',
    })
    catchup.resolve([{
      id: 'event-gap',
      runId: 'run-1',
      nodeId: 'node-gap',
      type: 'node.running',
      payload: {},
      createdAt: new Date('2026-07-13T00:00:01.000Z'),
    }])

    await handling
    expect(sendEventFrameMock.mock.calls.map(([, frame]) => [frame.event, frame.data.id])).toEqual([
      ['run-event', 'event-gap'],
      ['run-event', 'event-live'],
      ['run-status', undefined],
    ])
    close()
  })

  it('reconciles a terminal transition and trailing event published during catch-up', async () => {
    const catchup = deferred<CatchupRow[]>()
    arrangeRun('running', catchup.promise, 'succeeded')
    let publish: ((event: { kind: string; status?: string; id?: string; nodeId?: string; type?: string; payload?: Record<string, unknown>; createdAt?: string }) => void) | undefined
    addSubscriberMock.mockImplementation((_runId, _orgId, writer) => {
      publish = writer
      return { ok: true, ready: Promise.resolve(), remove: removeSubscriberMock }
    })
    const { req, close } = request()
    const res = response()

    const handling = streamRoute().handler({ req: req as never, res: res as never, auth })
    await flushMicrotasks()
    publish?.({ kind: 'run.status', status: 'succeeded' })
    publish?.({
      kind: 'event',
      id: 'event-trailing',
      nodeId: 'node-1',
      type: 'node.succeeded',
      payload: {},
      createdAt: '2026-07-13T00:00:03.000Z',
    })
    catchup.resolve([])

    await handling
    expect(sendEventFrameMock.mock.calls.map(([, frame]) => frame.event)).toEqual([
      'run-event',
      'run-status',
    ])
    expect(sendEventFrameMock).toHaveBeenLastCalledWith(res, {
      event: 'run-status',
      data: { kind: 'run.status', status: 'succeeded' },
    })
    close()
  })

  it('does not mark an exactly-full 500-event page as truncated', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      id: `event-${String(index).padStart(3, '0')}`,
      runId: 'run-1',
      nodeId: 'node-1',
      type: 'node.running',
      payload: {},
      createdAt: new Date(Date.UTC(2026, 6, 13, 0, 0, index)),
    }))
    arrangeRun('running', rows)
    const { req, close } = request()
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(sendEventFrameMock.mock.calls.filter(([, frame]) => frame.event === 'run-event')).toHaveLength(500)
    expect(sendEventFrameMock.mock.calls.some(([, frame]) => frame.event === 'catchup-truncated')).toBe(false)
    expect(sendEventFrameMock).toHaveBeenLastCalledWith(res, {
      event: 'run-status',
      data: { kind: 'run.status', status: 'running' },
    })
    close()
  })

  it('cleans up the stream when the post-header catch-up query rejects', async () => {
    arrangeRun('running', Promise.reject(new Error('database unavailable')))
    const { req } = request()
    const res = response()

    await expect(streamRoute().handler({ req: req as never, res: res as never, auth })).resolves.toBeUndefined()

    expect(res.headersSent).toBe(true)
    expect(removeSubscriberMock).toHaveBeenCalledOnce()
    expect(res.end).toHaveBeenCalledOnce()
    expect(sendErrorMock).not.toHaveBeenCalled()
  })

  it('waits for socket drain before continuing replay delivery', async () => {
    arrangeRun('running', [{
      id: 'event-1',
      runId: 'run-1',
      nodeId: 'node-1',
      type: 'node.running',
      payload: {},
      createdAt: new Date('2026-07-13T00:00:01.000Z'),
    }])
    sendEventFrameMock.mockReturnValueOnce(false).mockReturnValue(true)
    const { req, close } = request()
    const res = response()

    let settled = false
    const handling = streamRoute().handler({ req: req as never, res: res as never, auth })
      .finally(() => { settled = true })
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(sendEventFrameMock).toHaveBeenCalledTimes(1)

    res.emit('drain')
    await handling
    expect(sendEventFrameMock.mock.calls.map(([, frame]) => frame.event)).toEqual(['run-event', 'run-status'])
    close()
  })

  it('closes instead of buffering an unbounded live burst during catch-up', async () => {
    const catchup = deferred<CatchupRow[]>()
    arrangeRun('running', catchup.promise)
    let publish: ((event: { kind: 'event'; id: string; nodeId: string; type: string; payload: Record<string, unknown>; createdAt: string }) => void) | undefined
    addSubscriberMock.mockImplementation((_runId, _orgId, writer) => {
      publish = writer
      return { ok: true, ready: Promise.resolve(), remove: removeSubscriberMock }
    })
    const { req } = request()
    const res = response()

    const handling = streamRoute().handler({ req: req as never, res: res as never, auth })
    await flushMicrotasks()
    for (let index = 0; index < 4; index += 1) {
      publish?.({
        kind: 'event',
        id: `large-${index}`,
        nodeId: 'node-1',
        type: 'node.running',
        payload: { value: 'x'.repeat(300_000) },
        createdAt: `2026-07-13T00:00:0${index}.000Z`,
      })
    }
    catchup.resolve([])

    await handling
    expect(removeSubscriberMock).toHaveBeenCalledOnce()
    expect(res.end).toHaveBeenCalledOnce()
    expect(sendEventFrameMock).not.toHaveBeenCalled()
  })

  it('scopes the initial run lookup by both run and organization', async () => {
    const arranged = arrangeRun('running')
    const { req, close } = request()
    const res = response()

    await streamRoute().handler({ req: req as never, res: res as never, auth })

    expect(arranged.getInitialWhere()).toEqual({
      kind: 'and',
      conditions: [
        { kind: 'eq', left: 'runs.id', right: 'run-1' },
        { kind: 'eq', left: 'runs.org_id', right: 'org-1' },
      ],
    })
    close()
  })
})
