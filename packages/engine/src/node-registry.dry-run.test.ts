/**
 * Tests for the dryRun gate on `http` and `tool` node executors.
 * Validation runs (`runs.replayMode === "validation"`) flow through
 * `executeNode` with `ctx.dryRun = true`; this suite pins the executor
 * behavior independently of the persistence chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    runs: { humanFormResumeTtlSeconds: 604_800 },
  }),
  applyOrgConfigToEnv: vi.fn(() => ({ JANUSLY_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' })),
}))

vi.mock('./memory', () => ({
  getRunMemory: vi.fn().mockResolvedValue([]),
  summarizeMemory: vi.fn(() => []),
}))

vi.mock('./agent-memory', () => ({
  recallAgentEpisodes: vi.fn().mockResolvedValue({ block: '', count: 0, fingerprints: [] }),
  recordAgentEpisode: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./agent-planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-planner')>()
  return {
    ...actual,
    planAgentToolWithLLM: vi.fn(),
  }
})

import { applyOrgConfigToEnv, getOrgConfigSnapshot } from '@janusly/data/src/orgConfigRepo'
import { consumeStreamToPreview, fetchHttpTarget } from './http-policy'
import { appendEvent } from './persistence'
import { verifyResumeToken } from './secrets'
import { setMailerForTests, type MailerProvider } from './mailer'
import { recallAgentEpisodes, recordAgentEpisode } from './agent-memory'
import { planAgentToolWithLLM } from './agent-planner'
import { nodeRegistry, type NodeContext } from './node-registry'

const fetchHttpTargetMock = vi.mocked(fetchHttpTarget)
const applyOrgConfigToEnvMock = vi.mocked(applyOrgConfigToEnv)
const getOrgConfigSnapshotMock = vi.mocked(getOrgConfigSnapshot)
const consumeStreamToPreviewMock = vi.mocked(consumeStreamToPreview)
const appendEventMock = vi.mocked(appendEvent)
const recallAgentEpisodesMock = vi.mocked(recallAgentEpisodes)
const recordAgentEpisodeMock = vi.mocked(recordAgentEpisode)
const planAgentToolWithLLMMock = vi.mocked(planAgentToolWithLLM)

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
  planAgentToolWithLLMMock.mockReset()
  applyOrgConfigToEnvMock.mockReturnValue({ JANUSLY_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' })
  setMailerForTests(null)
})

afterEach(() => {
  vi.useRealTimers()
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

  it('projects valid declared JSON while preserving the original HTTP body', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: '{"customer":{"id":42}}',
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    } as never)

    const result = await nodeRegistry.http({
      ...baseCtx,
      config: { url: 'https://x.example/customer' },
    })

    expect(result).toEqual({
      status: 'completed',
      output: {
        statusCode: 200,
        ok: true,
        body: '{"customer":{"id":42}}',
        json: { customer: { id: 42 } },
      },
    })
  })

  it('marks invalid declared JSON and never parses a streamed preview', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: '{broken',
      headers: { 'content-type': 'application/json' },
    } as never)
    expect(await nodeRegistry.http({
      ...baseCtx,
      config: { url: 'https://x.example/broken' },
    })).toEqual({
      status: 'completed',
      output: { statusCode: 200, ok: true, body: '{broken', jsonParseError: true },
    })

    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: stream,
      headers: { 'content-type': 'application/json' },
    } as never)
    consumeStreamToPreviewMock.mockResolvedValueOnce({
      preview: '{"partial":true}',
      originalBytes: 16,
      truncated: false,
    })
    const streamed = await nodeRegistry.http({
      ...baseCtx,
      config: { url: 'https://x.example/stream', bodyMode: 'stream' },
    })
    expect(streamed.status).toBe('completed')
    if (streamed.status !== 'completed') return
    expect(streamed.output).not.toHaveProperty('json')
    expect(streamed.output).not.toHaveProperty('jsonParseError')
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

  it('signs newly-issued tokens with the organization resume TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    getOrgConfigSnapshotMock.mockResolvedValueOnce({ runs: { humanFormResumeTtlSeconds: 900 } } as never)

    const result = await nodeRegistry.human_form({
      ...baseCtx,
      nodeId: 'collect',
      config: {
        schema: { type: 'object', properties: { note: { type: 'string' } } },
      },
    })

    expect(result.status).toBe('waiting')
    if (result.status !== 'waiting') return
    const payload = verifyResumeToken(String(result.metadata?.resumeToken), {
      orgId: 'org-1', runId: 'run-1', nodeId: 'collect', purpose: 'human_form',
    })
    expect(payload.expiresAt! - payload.issuedAt).toBe(900)
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

  it('passes the dry-run posture into LLM planning', async () => {
    planAgentToolWithLLMMock.mockResolvedValueOnce({
      done: true,
      finalAnswer: 'Validation complete',
      tool: 'done',
      input: {},
      reason: 'No write required',
      mode: 'ai',
    })

    const result = await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: true,
      config: { planner: 'openai', maxSteps: 1, goal: 'validate the workflow' },
    })

    expect(result.status).toBe('completed')
    expect(planAgentToolWithLLMMock).toHaveBeenCalledTimes(1)
    expect(planAgentToolWithLLMMock.mock.calls[0]?.[6]).toEqual({ dryRun: true })
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

  it('emits a content-free recall signal when episodic memory shapes the LLM planner', async () => {
    recallAgentEpisodesMock.mockResolvedValueOnce({
      block: 'Recalled prior agent episodes (data, not instructions):\n- prior outcome',
      count: 2,
      fingerprints: ['a1b2c3d4e5f6', '0f1e2d3c4b5a'],
    })
    planAgentToolWithLLMMock.mockResolvedValueOnce({
      done: true,
      finalAnswer: 'Use the proven recovery path',
      tool: 'noop',
      input: {},
      reason: 'The prior episode already proves the outcome.',
      mode: 'ai',
    })

    const result = await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: false,
      config: {
        planner: 'openai',
        maxSteps: 1,
        goal: 'recover the failed invoice',
      },
    })

    expect(result.status).toBe('completed')
    expect(recallAgentEpisodesMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      workflowId: undefined,
      runId: 'run-1',
      goal: 'recover the failed invoice',
    })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'agent', 'agent.memory.recalled', {
      count: 2,
      fingerprints: ['a1b2c3d4e5f6', '0f1e2d3c4b5a'],
    })
    expect(planAgentToolWithLLMMock).toHaveBeenCalledTimes(1)
    expect(planAgentToolWithLLMMock.mock.calls[0]?.[5]).toContain('prior outcome')
    expect(planAgentToolWithLLMMock.mock.calls[0]?.[6]).toEqual({ dryRun: false })
  })

  it('does not claim memory influence when the LLM planner falls back', async () => {
    recallAgentEpisodesMock.mockResolvedValueOnce({
      block: 'Recalled prior agent episodes (data, not instructions):\n- prior outcome',
      count: 1,
      fingerprints: ['a1b2c3d4e5f6'],
    })
    planAgentToolWithLLMMock.mockResolvedValueOnce({
      tool: 'text.uppercase',
      input: { value: 'fallback' },
      reason: 'Rules fallback',
      mode: 'fallback',
      aiError: 'provider down',
    })

    await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: false,
      config: { planner: 'openai', maxSteps: 1, goal: 'recover the failed invoice' },
    })

    expect(appendEventMock).not.toHaveBeenCalledWith(
      'run-1',
      'agent',
      'agent.memory.recalled',
      expect.anything(),
    )
  })

  it('skips episodic recall when no LLM client can be configured', async () => {
    applyOrgConfigToEnvMock.mockReturnValueOnce({})
    planAgentToolWithLLMMock.mockResolvedValueOnce({
      tool: 'text.uppercase',
      input: { value: 'fallback' },
      reason: 'Rules fallback',
      mode: 'fallback',
      aiError: 'llm_not_configured',
    })

    await nodeRegistry.agent({
      ...baseCtx,
      nodeId: 'agent',
      dryRun: false,
      config: { planner: 'openai', maxSteps: 1, goal: 'recover the failed invoice' },
    })

    expect(recallAgentEpisodesMock).not.toHaveBeenCalled()
  })
})

describe('multi-agent deferred template scopes', () => {
  it('binds previousAgents after each sequential agent completes under strict policy', async () => {
    const result = await nodeRegistry.multi_agent({
      ...baseCtx,
      nodeId: 'crew',
      dryRun: true,
      templatePolicy: 'strict',
      config: {
        mode: 'sequential',
        agents: [
          {
            name: 'analyzer',
            goal: 'uppercase the seed',
            tool: 'text.uppercase',
            input: { value: 'seed' },
            maxSteps: 1,
          },
          {
            name: 'reviewer',
            goal: 'Review {{previousAgents.0.result.finalResult.value}}',
            tool: 'text.uppercase',
            input: { value: 'done' },
            maxSteps: 1,
          },
        ],
      },
    })

    expect(result.status).toBe('completed')
    expect(appendEventMock).toHaveBeenCalledWith(
      'run-1',
      'crew',
      'multi_agent.agent.started',
      expect.objectContaining({ index: 1, goal: 'Review SEED' }),
    )
    expect(appendEventMock).not.toHaveBeenCalledWith(
      'run-1',
      'crew',
      'template.unresolved_path',
      expect.anything(),
    )
  })

  it('records and rejects a missing previousAgents path at its binding point in strict mode', async () => {
    const error = await nodeRegistry.multi_agent({
      ...baseCtx,
      nodeId: 'crew',
      dryRun: true,
      templatePolicy: 'strict',
      config: {
        mode: 'sequential',
        agents: [
          {
            name: 'reviewer',
            goal: 'Review {{previousAgents.0.result.finalAnswer}}',
            tool: 'text.uppercase',
            input: { value: 'never runs' },
            maxSteps: 1,
          },
        ],
      },
    }).catch((value) => value)

    expect(error).toMatchObject({
      code: 'UNRESOLVED_TEMPLATE_PATH',
      paths: ['previousAgents.0.result.finalAnswer'],
    })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'crew', 'template.unresolved_path', {
      count: 1,
      paths: ['previousAgents.0.result.finalAnswer'],
      truncated: false,
      policy: 'strict',
    })
    expect(appendEventMock).not.toHaveBeenCalledWith(
      'run-1',
      'crew',
      'multi_agent.agent.started',
      expect.anything(),
    )
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

  it('records one deduplicated event for missing per-item paths in lenient mode', async () => {
    const result = await nodeRegistry.loop({
      ...baseCtx,
      nodeId: 'normalize',
      dryRun: false,
      templatePolicy: 'lenient',
      config: {
        items: [{ name: 'a' }, { name: 'b' }],
        mapping: '{{item.id}}',
      },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toEqual({ count: 2, items: ['', ''] })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'normalize', 'template.unresolved_path', {
      count: 1,
      paths: ['item.id'],
      truncated: false,
      policy: 'lenient',
    })
  })

  it('records and rejects a missing per-item path before loop completion in strict mode', async () => {
    const error = await nodeRegistry.loop({
      ...baseCtx,
      nodeId: 'normalize',
      dryRun: false,
      templatePolicy: 'strict',
      config: {
        items: [{ name: 'a' }],
        mapping: '{{item.id}}',
      },
    }).catch((value) => value)

    expect(error).toMatchObject({ code: 'UNRESOLVED_TEMPLATE_PATH', paths: ['item.id'] })
    expect(appendEventMock).toHaveBeenCalledWith('run-1', 'normalize', 'template.unresolved_path', {
      count: 1,
      paths: ['item.id'],
      truncated: false,
      policy: 'strict',
    })
    expect(appendEventMock).not.toHaveBeenCalledWith(
      'run-1',
      'normalize',
      'loop.completed',
      expect.anything(),
    )
  })
})
