/**
 * Tests for the dryRun gate on `http` and `tool` node executors.
 * Validation runs (`runs.replayMode === "validation"`) flow through
 * `executeNode` with `ctx.dryRun = true`; this suite pins the executor
 * behavior independently of the persistence chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./http-policy', () => ({
  fetchHttpTarget: vi.fn(),
}))

// Partially mock `./persistence`: only `appendEvent` is exercised by the
// http/tool executors here, but the module is imported elsewhere in the
// registry's transitive load (subworkflow notifier, persistence helpers
// for other node types). Use `importOriginal` so unmocked exports stay.
vi.mock('./persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persistence')>()
  return {
    ...actual,
    appendEvent: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@janusly/data/src/orgConfigRepo', () => ({
  getOrgConfigSnapshot: vi.fn().mockResolvedValue({
    ai: { provider: 'openai', model: 'gpt-4o-mini', rateLimitPerMin: 60 },
    http: { timeoutMs: 30_000, maxResponseBytes: 1_000_000, maxRedirects: 5 },
    runs: {},
  }),
  applyOrgConfigToEnv: vi.fn(),
}))

import { fetchHttpTarget } from './http-policy'
import { appendEvent } from './persistence'
import { nodeRegistry, type NodeContext } from './node-registry'

const fetchHttpTargetMock = vi.mocked(fetchHttpTarget)
const appendEventMock = vi.mocked(appendEvent)

const baseCtx: Omit<NodeContext, 'config'> = {
  runId: 'run-1',
  nodeId: 'fetch',
  orgId: 'org-1',
  workflowId: null,
  context: {},
  redactedValues: [],
}

beforeEach(() => {
  fetchHttpTargetMock.mockReset()
  appendEventMock.mockReset()
})

describe('http node — dryRun gating', () => {
  it('skips POST in dryRun mode and emits node.dry_run.skipped', async () => {
    const result = await nodeRegistry.http({
      ...baseCtx,
      dryRun: true,
      config: { url: 'https://x.example', method: 'POST' },
    })

    expect(result).toEqual({
      status: 'completed',
      output: { statusCode: 0, ok: true, body: null, dryRun: true },
    })
    expect(fetchHttpTargetMock).not.toHaveBeenCalled()
    expect(appendEventMock).toHaveBeenCalledWith(
      'run-1',
      'fetch',
      'node.dry_run.skipped',
      expect.objectContaining({ method: 'POST', url: 'https://x.example' }),
    )
  })

  it('still executes GET in dryRun mode (read-side methods are safe)', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: 'ok',
      headers: {},
    } as never)

    const result = await nodeRegistry.http({
      ...baseCtx,
      dryRun: true,
      config: { url: 'https://x.example', method: 'GET' },
    })

    expect(fetchHttpTargetMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toMatchObject({ statusCode: 200, ok: true })
    expect(appendEventMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'node.dry_run.skipped',
      expect.anything(),
    )
  })

  it('still executes POST in production mode (dryRun unset)', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 201,
      ok: true,
      body: '{"id":1}',
      headers: {},
    } as never)

    const result = await nodeRegistry.http({
      ...baseCtx,
      config: { url: 'https://x.example', method: 'POST', body: { foo: 'bar' } },
    })

    expect(fetchHttpTargetMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toMatchObject({ statusCode: 201, ok: true })
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'gates %s in dryRun mode',
    async (method) => {
      const result = await nodeRegistry.http({
        ...baseCtx,
        dryRun: true,
        config: { url: 'https://x.example', method },
      })
      expect(fetchHttpTargetMock).not.toHaveBeenCalled()
      expect(result.status).toBe('completed')
      if (result.status !== 'completed') return
      expect(result.output).toMatchObject({ dryRun: true })
    },
  )
})

describe('tool node — dryRun gating', () => {
  it('skips http.request POST in dryRun mode and emits tool.dry_run.skipped', async () => {
    const result = await nodeRegistry.tool({
      ...baseCtx,
      dryRun: true,
      config: { tool: 'http.request', input: { url: 'https://x.example', method: 'POST' } },
    })

    expect(result).toEqual({
      status: 'completed',
      output: { tool: 'http.request', dryRun: true, skipped: true },
    })
    expect(fetchHttpTargetMock).not.toHaveBeenCalled()
    expect(appendEventMock).toHaveBeenCalledWith(
      'run-1',
      'fetch',
      'tool.dry_run.skipped',
      expect.objectContaining({ tool: 'http.request', method: 'POST' }),
    )
  })

  it('still executes http.request GET in dryRun mode', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: 'ok',
      headers: {},
    } as never)

    const result = await nodeRegistry.tool({
      ...baseCtx,
      dryRun: true,
      config: { tool: 'http.request', input: { url: 'https://x.example', method: 'GET' } },
    })

    expect(fetchHttpTargetMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toMatchObject({ tool: 'http.request' })
    expect((result.output as { skipped?: boolean }).skipped).toBeUndefined()
  })

  it('does not gate read-side tools (text.uppercase) in dryRun mode', async () => {
    const result = await nodeRegistry.tool({
      ...baseCtx,
      dryRun: true,
      config: { tool: 'text.uppercase', input: { value: 'hi' } },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toMatchObject({ tool: 'text.uppercase', result: { value: 'HI' } })
  })
})
