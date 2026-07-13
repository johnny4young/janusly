/**
 * Tests for the dryRun gate on `http` and `tool` node executors.
 * Validation runs (`runs.replayMode === "validation"`) flow through
 * `executeNode` with `ctx.dryRun = true`; this suite pins the executor
 * behavior independently of the persistence chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./http-policy', () => ({
  consumeStreamToPreview: vi.fn(),
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
    http: { timeoutMs: 30_000, maxResponseBytes: 1_000_000, maxRedirects: 5, streamPreviewBytes: 65_536 },
    email: { provider: 'noop', from: 'sender@example.com', rateLimitPerMin: 100 },
    runs: {},
  }),
  applyOrgConfigToEnv: vi.fn(),
}))

vi.mock('./memory', () => ({
  getRunMemory: vi.fn().mockResolvedValue([]),
  summarizeMemory: vi.fn(() => []),
}))

vi.mock('./agent-memory', () => ({
  recallAgentEpisodes: vi.fn().mockResolvedValue({ block: '', count: 0 }),
  recordAgentEpisode: vi.fn().mockResolvedValue(undefined),
}))

import { consumeStreamToPreview, fetchHttpTarget } from './http-policy'
import { appendEvent } from './persistence'
import { verifyResumeToken } from './secrets'
import { setMailerForTests, type MailerProvider } from './mailer'
import { recallAgentEpisodes, recordAgentEpisode } from './agent-memory'
import { nodeRegistry, type NodeContext } from './node-registry'

const fetchHttpTargetMock = vi.mocked(fetchHttpTarget)
const consumeStreamToPreviewMock = vi.mocked(consumeStreamToPreview)
const appendEventMock = vi.mocked(appendEvent)
const recallAgentEpisodesMock = vi.mocked(recallAgentEpisodes)
const recordAgentEpisodeMock = vi.mocked(recordAgentEpisode)

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
  consumeStreamToPreviewMock.mockReset()
  appendEventMock.mockReset()
  // mockClear (not mockReset) so the default resolved values from the mock
  // factory survive across cases.
  recallAgentEpisodesMock.mockClear()
  recordAgentEpisodeMock.mockClear()
  setMailerForTests(null)
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

  it('consumes streaming responses into a JSON-safe preview envelope', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('preview'))
        controller.close()
      },
    })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: stream,
      headers: {},
    } as never)
    consumeStreamToPreviewMock.mockResolvedValueOnce({
      preview: 'preview',
      originalBytes: 7,
      truncated: false,
    })

    const result = await nodeRegistry.http({
      ...baseCtx,
      config: { url: 'https://x.example', method: 'GET', bodyMode: 'stream' },
    })

    expect(fetchHttpTargetMock).toHaveBeenCalledWith(
      'https://x.example',
      expect.objectContaining({
        method: 'GET',
        bodyMode: 'stream',
        timeoutMs: 30_000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 5,
      }),
    )
    expect(consumeStreamToPreviewMock).toHaveBeenCalledWith(stream, 65_536)
    expect(result).toEqual({
      status: 'completed',
      output: {
        statusCode: 200,
        ok: true,
        body: 'preview',
        streamed: true,
        streamedBytes: 7,
        streamTruncated: false,
      },
    })
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

  it.each(['db.query.write', 'db.query.transaction'])(
    'skips %s in dryRun mode and emits tool.dry_run.skipped',
    async (tool) => {
      const result = await nodeRegistry.tool({
        ...baseCtx,
        dryRun: true,
        config: { tool, input: { credential: 'customer-db', sql: 'update customers set active = $1', params: [true] } },
      })

      expect(result).toEqual({
        status: 'completed',
        output: { tool, dryRun: true, skipped: true },
      })
      expect(appendEventMock).toHaveBeenCalledWith(
        'run-1',
        'fetch',
        'tool.dry_run.skipped',
        expect.objectContaining({ tool }),
      )
    },
  )

  it('skips vector.upsert in dryRun mode and emits tool.dry_run.skipped', async () => {
    const result = await nodeRegistry.tool({
      ...baseCtx,
      dryRun: true,
      config: { tool: 'vector.upsert', input: { content: 'cus_1 churned', metadata: { customerId: 'cus_1' } } },
    })

    expect(result).toEqual({
      status: 'completed',
      output: { tool: 'vector.upsert', dryRun: true, skipped: true },
    })
    expect(appendEventMock).toHaveBeenCalledWith(
      'run-1',
      'fetch',
      'tool.dry_run.skipped',
      expect.objectContaining({ tool: 'vector.upsert' }),
    )
  })
})

describe('human_form node — waiting metadata', () => {
  it('pauses with a signed resume token and a serializable form schema', async () => {
    const result = await nodeRegistry.human_form({
      ...baseCtx,
      nodeId: 'collect',
      config: {
        title: 'PTO request',
        description: 'Collect manager review details.',
        schema: {
          type: 'object',
          properties: {
            requester: { type: 'string', description: 'Employee name' },
            days: { type: 'number' },
          },
          required: ['requester', 'days'],
        },
      },
    })

    expect(result.status).toBe('waiting')
    if (result.status !== 'waiting') return
    expect(result.reason).toBe('Waiting for form submission')
    expect(result.metadata).toMatchObject({
      kind: 'human_form',
      title: 'PTO request',
      description: 'Collect manager review details.',
      schema: {
        type: 'object',
        properties: {
          requester: { type: 'string', description: 'Employee name' },
          days: { type: 'number' },
        },
        required: ['requester', 'days'],
      },
    })
    const token = result.metadata?.resumeToken
    expect(typeof token).toBe('string')
    verifyResumeToken(String(token), { orgId: 'org-1', runId: 'run-1', nodeId: 'collect', purpose: 'human_form' })
  })

  it('rejects invalid schemas instead of parking an unusable form', async () => {
    await expect(nodeRegistry.human_form({
      ...baseCtx,
      nodeId: 'collect',
      config: { schema: { type: 'object', properties: { bad: { type: 'date' } } } },
    })).rejects.toThrow()
  })
})

describe('operator waits — classified metadata', () => {
  it('carries approval title and description into the waiting checkpoint', async () => {
    const result = await nodeRegistry.approval({
      ...baseCtx,
      nodeId: 'approve',
      config: { title: 'Approve refund', description: 'Review the supporting evidence.' },
    })

    expect(result).toMatchObject({
      status: 'waiting',
      reason: 'Waiting for human approval',
      metadata: {
        kind: 'approval',
        title: 'Approve refund',
        description: 'Review the supporting evidence.',
      },
    })
  })

  it('uses the legacy approval message as the display title and classifies webhooks', async () => {
    const approval = await nodeRegistry.approval({ ...baseCtx, nodeId: 'approve', config: { message: 'Finance sign-off' } })
    const webhook = await nodeRegistry.webhook({ ...baseCtx, nodeId: 'callback', config: {} })

    expect(approval).toMatchObject({ metadata: { kind: 'approval', title: 'Finance sign-off' } })
    expect(webhook).toMatchObject({ metadata: { kind: 'webhook' } })
  })
})

describe('agent node — dryRun gating', () => {
  it('skips explicit write-side tools in dryRun mode', async () => {
    const send = vi.fn(async () => ({ ok: true, provider: 'resend' as const, providerMessageId: 'msg-1' }))
    setMailerForTests({ name: 'resend', send: send as MailerProvider['send'] })

    const result = await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: true,
      config: {
        maxSteps: 1,
        tool: 'email.send',
        input: { to: 'u@e.com', subject: 'Hi', text: 'Hello', from: 's@e.com' },
      },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toMatchObject({
      finalResult: { tool: 'email.send', dryRun: true, skipped: true },
    })
    expect(send).not.toHaveBeenCalled()
    expect(appendEventMock).toHaveBeenCalledWith(
      'run-1',
      'agent',
      'tool.dry_run.skipped',
      expect.objectContaining({ tool: 'email.send' }),
    )
    // Write-back is gated off in dryRun so sandbox runs don't pollute memory.
    expect(recordAgentEpisodeMock).not.toHaveBeenCalled()
  })

  it('records an episode on completion in production mode (rules planner skips recall)', async () => {
    const result = await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: false,
      config: {
        maxSteps: 1,
        goal: 'uppercase the greeting',
        tool: 'text.uppercase',
        input: { value: 'hi' },
      },
    })

    expect(result.status).toBe('completed')
    expect(recordAgentEpisodeMock).toHaveBeenCalledTimes(1)
    expect(recordAgentEpisodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', runId: 'run-1', goal: 'uppercase the greeting', stepCount: 1 }),
    )
    // The deterministic rules planner ignores memory, so no recall/embedding fires.
    expect(recallAgentEpisodesMock).not.toHaveBeenCalled()
  })
})

describe('loop node — array reference resolution', () => {
  it('preserves an array reference from context (single-template-reference shape)', async () => {
    const result = await nodeRegistry.loop({
      ...baseCtx,
      nodeId: 'normalize',
      dryRun: false,
      context: { trigger: { output: { customers: [
        { id: 'c1', email: 'a@example.com', plan: 'free' },
        { id: 'c2', email: 'b@example.com', plan: 'team' },
        { id: 'c3', email: 'c@example.com', plan: 'free' },
      ] } } },
      config: {
        items: '{{context.trigger.output.customers}}',
        mapping: 'Customer {{item.id}} — plan={{item.plan}}',
      },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toEqual({
      count: 3,
      items: [
        'Customer c1 — plan=free',
        'Customer c2 — plan=team',
        'Customer c3 — plan=free',
      ],
    })
  })

  it('still accepts comma-separated string input (backwards compatibility)', async () => {
    const result = await nodeRegistry.loop({
      ...baseCtx,
      nodeId: 'normalize',
      dryRun: false,
      config: {
        items: 'one, two, three',
        mapping: 'item={{item}}',
      },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toEqual({
      count: 3,
      items: ['item=one', 'item=two', 'item=three'],
    })
  })

  it('returns zero iterations when the referenced array is missing', async () => {
    const result = await nodeRegistry.loop({
      ...baseCtx,
      nodeId: 'normalize',
      dryRun: false,
      context: {},
      config: {
        items: '{{context.missing.output.list}}',
        mapping: '{{item}}',
      },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toEqual({ count: 0, items: [] })
  })
})
