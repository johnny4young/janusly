/** Route-level regression coverage for the bounded run-history query. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { directLimitMock, eqMock, isNullMock, limitMock, ltMock, replayDecisionMock, selectMock, sendJsonMock } = vi.hoisted(() => {
  const limit = vi.fn(async () => [{ id: 'run-1', workflowId: 'wf-1', status: 'failed' }])
  const orderBy = vi.fn(() => ({ limit }))
  const where = vi.fn(() => ({ orderBy }))
  const leftJoin = vi.fn(() => ({ where }))
  const directLimit = vi.fn()
  const directWhere = vi.fn(() => ({ limit: directLimit }))
  const from = vi.fn(() => ({ leftJoin, where: directWhere }))
  return {
    directLimitMock: directLimit,
    eqMock: vi.fn((left: unknown, right: unknown) => ({ kind: 'eq', left, right })),
    isNullMock: vi.fn((value: unknown) => ({ kind: 'isNull', value })),
    limitMock: limit,
    ltMock: vi.fn((left: unknown, right: unknown) => ({ kind: 'lt', left, right })),
    replayDecisionMock: vi.fn(),
    selectMock: vi.fn(() => ({ from })),
    sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  }
})

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
  asc: vi.fn((value: unknown) => ({ kind: 'asc', value })),
  desc: vi.fn((value: unknown) => ({ kind: 'desc', value })),
  eq: eqMock,
  gt: vi.fn((left: unknown, right: unknown) => ({ kind: 'gt', left, right })),
  isNull: isNullMock,
  lt: ltMock,
  or: vi.fn((...conditions: unknown[]) => ({ kind: 'or', conditions })),
  sql: vi.fn(() => 'resolved-workflow-id'),
}))

vi.mock('@janusly/data', () => ({
  getOrgConfigSnapshot: vi.fn(),
  getRunComparison: vi.fn(),
  getWorkflowStatus: vi.fn(),
  queryRunUsage: vi.fn(),
  WORKFLOW_STATUS_ACTIVE: 'active',
}))

vi.mock('@janusly/db', () => ({
  db: { select: selectMock },
  runEvents: {
    id: 'run_events.id',
    runId: 'run_events.run_id',
    nodeId: 'run_events.node_id',
    type: 'run_events.type',
  },
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
  },
  workflows: {},
  workflowVersions: {
    id: 'workflow_versions.id',
    orgId: 'workflow_versions.org_id',
    workflowId: 'workflow_versions.workflow_id',
  },
}))

vi.mock('@janusly/domain', () => ({ replayDecision: replayDecisionMock }))
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
  corsHeaders: vi.fn(),
  readJson: vi.fn(),
  sendEventFrame: vi.fn(),
  sendError: (_res: unknown, code: string, message: string, status = 400) =>
    sendJsonMock(_res, { error: message, code }, status),
  sendJson: sendJsonMock,
  sendSseComment: vi.fn(),
}))
vi.mock('../mcp-consent', () => ({ guardMcpWrite: vi.fn() }))
vi.mock('../rate-limit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('../readiness-helpers', () => ({
  checkRollbackAvailability: vi.fn(),
  getCredentialReadinessIssues: vi.fn(),
  mergeReadiness: vi.fn(),
  productionSecretRefResolver: vi.fn(),
}))
vi.mock('../run-stream', () => ({ getRunStreamHub: vi.fn() }))

import { queryRunUsage } from '@janusly/data'
import { runsRoutes } from './runs-routes'

const queryRunUsageMock = vi.mocked(queryRunUsage)

const auth = {
  orgId: 'org-1',
  userId: 'user-1',
  mode: 'dev-headers' as const,
  source: 'dev' as const,
}

function listRoute() {
  const route = runsRoutes.find(candidate => candidate.method === 'GET'
    && typeof candidate.match === 'function'
    && candidate.match('/runs?limit=1'))
  if (!route) throw new Error('GET /runs route not found')
  return route
}

beforeEach(() => {
  eqMock.mockClear()
  directLimitMock.mockReset()
  isNullMock.mockClear()
  limitMock.mockClear()
  ltMock.mockClear()
  selectMock.mockClear()
  sendJsonMock.mockClear()
  replayDecisionMock.mockReset()
  replayDecisionMock.mockReturnValue({ chosen: {}, best: {}, ranking: [] })
  queryRunUsageMock.mockReset()
})

describe('GET /runs history filters', () => {
  it('returns a tenant-scoped bounded usage projection for one run', async () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/run/usage?runId=run-1'))
    if (!route) throw new Error('GET /run/usage route not found')
    directLimitMock.mockResolvedValueOnce([{ id: 'run-1' }])
    queryRunUsageMock.mockResolvedValueOnce({ loadedRows: 0 } as never)

    await route.handler({
      req: { url: '/run/usage?runId=run-1' } as never,
      res: {} as never,
      auth,
    })

    expect(route.permission).toBe('runs.read')
    expect(eqMock).toHaveBeenCalledWith('runs.id', 'run-1')
    expect(eqMock).toHaveBeenCalledWith('runs.org_id', 'org-1')
    expect(queryRunUsageMock).toHaveBeenCalledWith('org-1', 'run-1')
    expect(sendJsonMock).toHaveBeenLastCalledWith({}, { loadedRows: 0 })
  })

  it('pins run usage response bounds at the v1 contract boundary', () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/run/usage?runId=run-1'))
    if (!route?.contract) throw new Error('GET /run/usage contract not found')
    const usage = {
      loadedRows: 1,
      truncated: false,
      rowCap: 10_000,
      llm: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        knownCostUsd: 0,
        unknownCostCalls: 0,
      },
      memory: {
        recalls: 0,
        commits: 0,
        failures: 0,
        kinds: [{ kind: 'agent_episode', recalls: 0, commits: 0, failures: 0 }],
      },
    }

    expect(route.contract.response.safeParse(usage).success).toBe(true)
    expect(route.contract.response.safeParse({ ...usage, loadedRows: 10_001 }).success).toBe(false)
    expect(route.contract.response.safeParse({
      ...usage,
      memory: { ...usage.memory, kinds: [{ ...usage.memory.kinds[0], kind: '' }] },
    }).success).toBe(false)
  })

  it('rejects missing or foreign run usage reads without querying usage rows', async () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/run/usage?runId=foreign'))
    if (!route) throw new Error('GET /run/usage route not found')

    await route.handler({ req: { url: '/run/usage' } as never, res: {} as never, auth })
    expect(sendJsonMock).toHaveBeenLastCalledWith(
      {},
      { error: 'runId is required', code: 'runs_run_id_required' },
      400,
    )

    directLimitMock.mockResolvedValueOnce([])
    await route.handler({
      req: { url: '/run/usage?runId=foreign' } as never,
      res: {} as never,
      auth,
    })
    expect(queryRunUsageMock).not.toHaveBeenCalled()
    expect(sendJsonMock).toHaveBeenLastCalledWith(
      {},
      { error: 'Forbidden', code: 'runs_forbidden' },
      403,
    )
  })

  it('keeps causal replay behind the run-read permission', () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/causal?runId=run-1&eventId=event-1&nodeId=route'))
    expect(route?.permission).toBe('runs.read')
    if (!route || typeof route.match !== 'function') throw new Error('GET /causal route not found')
    expect(route.match('/causal-export?runId=run-1&eventId=event-1&nodeId=route')).toBe(false)
  })

  it('bounds causal replay to the tenant run and exact decision event', async () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/causal?runId=run-1&eventId=event-1&nodeId=route'))
    if (!route) throw new Error('GET /causal route not found')
    directLimitMock
      .mockResolvedValueOnce([{ id: 'run-1', orgId: 'org-1' }])
      .mockResolvedValueOnce([{ id: 'event-1', nodeId: 'route', type: 'decision.made', payload: {} }])

    await route.handler({
      req: { url: '/causal?runId=run-1&eventId=event-1&nodeId=route' } as never,
      res: {} as never,
      auth,
    })

    expect(eqMock).toHaveBeenCalledWith('runs.id', 'run-1')
    expect(eqMock).toHaveBeenCalledWith('runs.org_id', 'org-1')
    expect(eqMock).toHaveBeenCalledWith('run_events.id', 'event-1')
    expect(eqMock).toHaveBeenCalledWith('run_events.run_id', 'run-1')
    expect(eqMock).toHaveBeenCalledWith('run_events.node_id', 'route')
    expect(eqMock).toHaveBeenCalledWith('run_events.type', 'decision.made')
    expect(directLimitMock).toHaveBeenCalledTimes(2)
    expect(directLimitMock).toHaveBeenNthCalledWith(1, 1)
    expect(directLimitMock).toHaveBeenNthCalledWith(2, 1)
    expect(replayDecisionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign causal run before reading any event', async () => {
    const route = runsRoutes.find(candidate => candidate.method === 'GET'
      && typeof candidate.match === 'function'
      && candidate.match('/causal?runId=foreign&eventId=event-1&nodeId=route'))
    if (!route) throw new Error('GET /causal route not found')
    directLimitMock.mockResolvedValueOnce([])

    await route.handler({
      req: { url: '/causal?runId=foreign&eventId=event-1&nodeId=route' } as never,
      res: {} as never,
      auth,
    })

    expect(eqMock).toHaveBeenCalledWith('runs.org_id', 'org-1')
    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(directLimitMock).toHaveBeenCalledTimes(1)
    expect(replayDecisionMock).not.toHaveBeenCalled()
    expect(sendJsonMock).toHaveBeenLastCalledWith(
      {},
      { error: 'Forbidden', code: 'runs_forbidden' },
      403,
    )
  })

  it('composes tenant, workflow, status, and strict before-cursor predicates', async () => {
    await listRoute().handler({
      req: { url: '/runs?workflowId=wf-1&status=failed&runKind=production&before=2026-07-10T12%3A00%3A00.000Z%7Crun-9&limit=1' } as never,
      res: {} as never,
      auth,
    })

    expect(eqMock).toHaveBeenCalledWith('runs.org_id', 'org-1')
    expect(eqMock).toHaveBeenCalledWith('workflow_versions.org_id', 'org-1')
    expect(eqMock).toHaveBeenCalledWith('workflow_versions.workflow_id', 'wf-1')
    expect(eqMock).toHaveBeenCalledWith('runs.workflow_version_id', 'wf-1')
    expect(isNullMock).toHaveBeenCalledWith('workflow_versions.id')
    expect(eqMock).toHaveBeenCalledWith('runs.status', 'failed')
    expect(isNullMock).toHaveBeenCalledWith('runs.replay_mode')
    expect(eqMock).toHaveBeenCalledWith('runs.created_at', new Date('2026-07-10T12:00:00.000Z'))
    expect(ltMock).toHaveBeenCalledWith('runs.id', 'run-9')
    expect(limitMock).toHaveBeenCalledWith(1)
    expect(sendJsonMock).toHaveBeenLastCalledWith({}, [{ id: 'run-1', workflowId: 'wf-1', status: 'failed' }])
  })

  it('rejects an unknown status without touching the database', async () => {
    await listRoute().handler({
      req: { url: '/runs?status=green' } as never,
      res: {} as never,
      auth,
    })

    expect(selectMock).not.toHaveBeenCalled()
    expect(sendJsonMock).toHaveBeenLastCalledWith(
      {},
      { error: 'status must be a valid run status', code: 'invalid_input' },
      400,
    )
  })

  it('rejects an unknown run kind without touching the database', async () => {
    await listRoute().handler({
      req: { url: '/runs?runKind=sandbox' } as never,
      res: {} as never,
      auth,
    })

    expect(selectMock).not.toHaveBeenCalled()
    expect(sendJsonMock).toHaveBeenLastCalledWith(
      {},
      { error: 'runKind must be production or validation', code: 'invalid_input' },
      400,
    )
  })

  it('selects validation runs explicitly', async () => {
    await listRoute().handler({
      req: { url: '/runs?runKind=validation' } as never,
      res: {} as never,
      auth,
    })

    expect(eqMock).toHaveBeenCalledWith('runs.replay_mode', 'validation')
    expect(isNullMock).not.toHaveBeenCalled()
  })

  it('preserves the 200-row hard cap', async () => {
    await listRoute().handler({
      req: { url: '/runs?limit=999' } as never,
      res: {} as never,
      auth,
    })

    expect(limitMock).toHaveBeenCalledWith(200)
  })
})
