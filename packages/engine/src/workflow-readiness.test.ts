import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@janusly/shared'
import { checkWorkflowReadiness } from './workflow-readiness'

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    dslVersion: '1.0',
    nodes: [],
    edges: [],
    ...partial,
  } as Workflow
}

describe('checkWorkflowReadiness', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('flags http nodes that rely on platform default bounds with a warn', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET', retry: { maxAttempts: 3 } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'http_missing_bounds',
      severity: 'warn',
      nodeId: 'fetch',
    }))
  })

  it('does not flag http_missing_bounds when at least one bound is explicit', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET', timeoutMs: 5000, retry: { maxAttempts: 3 } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'http_missing_bounds')).toBeUndefined()
  })

  it('flags external-call nodes with no retry policy as fail', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET' } },
        { id: 'transform', type: 'transform', config: { mapping: { value: '{{context.fetch.output.body}}' } } }, // not external — should not flag
        { id: 'summarise', type: 'ai', config: { prompt: 'summary please' } },
      ],
    })
    const result = checkWorkflowReadiness(workflow)
    const failures = result.issues.filter((issue) => issue.code === 'external_node_missing_retry')
    expect(failures.map((issue) => issue.nodeId)).toEqual(['fetch', 'summarise'])
    expect(failures.every((issue) => issue.severity === 'fail')).toBe(true)
  })

  it('does not flag external_node_missing_retry when maxAttempts >= 2', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', timeoutMs: 5000, retry: { maxAttempts: 3 } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'external_node_missing_retry')).toBeUndefined()
  })

  it('flags workflows with no declared outputs as warn', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'noop', type: 'noop', config: {} }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'workflow_missing_outputs',
      severity: 'warn',
    }))
  })

  it('does not flag workflow_missing_outputs when at least one output is declared', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'noop', type: 'noop', config: {} }],
      outputs: { result: '{{context.noop.output}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'workflow_missing_outputs')).toBeUndefined()
  })

  it('flags POST http nodes without an approval ancestor as warn', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'post', type: 'http', config: { url: 'https://api.example.com', method: 'POST', timeoutMs: 5000, retry: { maxAttempts: 3 } } },
      ],
      edges: [{ from: 'start', to: 'post' }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'sensitive_action_missing_approval',
      nodeId: 'post',
      severity: 'warn',
    }))
  })

  it('does not flag a POST http node when there is an approval ancestor', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'review', type: 'approval', config: { message: 'Please approve.' } },
        { id: 'post', type: 'http', config: { url: 'https://api.example.com', method: 'POST', timeoutMs: 5000, retry: { maxAttempts: 3 } } },
      ],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'post' },
      ],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'sensitive_action_missing_approval')).toBeUndefined()
  })

  it('flags a write-side tool name as a sensitive action', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'send', type: 'tool', config: { tool: 'email.send', input: { to: 'user@example.com' }, retry: { maxAttempts: 3 } } },
      ],
      edges: [{ from: 'start', to: 'send' }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'sensitive_action_missing_approval',
      nodeId: 'send',
    }))
  })

  it('flags write-side db query tools as sensitive actions', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'write_db', type: 'tool', config: { tool: 'db.query.write', input: { credential: 'customer-db', sql: 'update customers set active = $1', params: [true] }, retry: { maxAttempts: 3 } } },
        { id: 'read_db', type: 'tool', config: { tool: 'db.query.read', input: { credential: 'customer-db', sql: 'select id from customers' }, retry: { maxAttempts: 3 } } },
      ],
      edges: [{ from: 'start', to: 'write_db' }, { from: 'write_db', to: 'read_db' }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'sensitive_action_missing_approval',
      nodeId: 'write_db',
    }))
    expect(result.issues.find((issue) => issue.code === 'sensitive_action_missing_approval' && issue.nodeId === 'read_db')).toBeUndefined()
  })

  it('flags every mcp_tool node as a sensitive action (fail-safe — workflow JSON has no visibility into the descriptor writeSide flag)', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'edit_page', type: 'mcp_tool', config: { connectionAlias: 'notion', toolName: 'pages.update', input: { pageId: 'p1' }, retry: { maxAttempts: 3 } } },
      ],
      edges: [{ from: 'start', to: 'edit_page' }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'sensitive_action_missing_approval',
      nodeId: 'edit_page',
    }))
  })

  it('does not flag an mcp_tool node when there is an approval ancestor', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'review', type: 'approval', config: { message: 'Approve before editing the Notion page.' } },
        { id: 'edit_page', type: 'mcp_tool', config: { connectionAlias: 'notion', toolName: 'pages.update', input: { pageId: 'p1' }, retry: { maxAttempts: 3 } } },
      ],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'edit_page' },
      ],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'sensitive_action_missing_approval')).toBeUndefined()
  })

  it('flags hardcoded secret-like values in node config as fail', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET', timeoutMs: 5000, retry: { maxAttempts: 3 }, headers: { Authorization: 'Bearer literal-leaky-token' } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'raw_secret_in_config',
      severity: 'fail',
      nodeId: 'fetch',
    }))
  })

  it('does not flag template-referenced secrets', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET', timeoutMs: 5000, retry: { maxAttempts: 3 }, headers: { Authorization: 'Bearer {{secret.GITHUB_TOKEN}}' } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'raw_secret_in_config')).toBeUndefined()
  })

  it('does flag unsupported credential-template strings', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET', timeoutMs: 5000, retry: { maxAttempts: 3 }, headers: { Authorization: 'Bearer {{credential.GITHUB_TOKEN}}' } } }],
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'raw_secret_in_config',
      nodeId: 'fetch',
    }))
  })

  it('rolls up to fail when any issue is fail-level even alongside warns', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET' } }],
    })
    const result = checkWorkflowReadiness(workflow)
    // http_missing_bounds (warn) + external_node_missing_retry (fail) + workflow_missing_outputs (warn).
    expect(result.status).toBe('fail')
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set([
      'http_missing_bounds',
      'external_node_missing_retry',
      'workflow_missing_outputs',
    ]))
  })

  it('reaches status: "pass" with zero issues when the workflow is clean and eval coverage is not required', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'noop', type: 'noop', config: {} }],
      outputs: { ok: 'yes' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.status).toBe('pass')
    expect(result.issues).toEqual([])
  })

  it('emits the eval-coverage placeholder warn only when JANUSLY_REQUIRE_EVAL_COVERAGE=true', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'noop', type: 'noop', config: {} }],
      outputs: { ok: 'yes' },
    })

    vi.stubEnv('JANUSLY_REQUIRE_EVAL_COVERAGE', 'true')
    const required = checkWorkflowReadiness(workflow)
    expect(required.status).toBe('warn')
    expect(required.issues.map((issue) => issue.code)).toEqual(['workflow_missing_evals'])

    vi.unstubAllEnvs()
    const optional = checkWorkflowReadiness(workflow)
    expect(optional.status).toBe('pass')
    expect(optional.issues).toEqual([])
  })

  it('warns when a parallel_fork has no join downstream', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'fork', to: 'a' },
        { from: 'fork', to: 'b' },
      ],
      outputs: { ok: 'yes' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'fork_without_join_pair',
      severity: 'warn',
      nodeId: 'fork',
    }))
  })

  it('does not warn when a parallel_fork is paired with a join transitively downstream', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
        { id: 'merge', type: 'join', config: { sources: { a: 'a', b: 'b' } } },
      ],
      edges: [
        { from: 'fork', to: 'a' },
        { from: 'fork', to: 'b' },
        { from: 'a', to: 'merge' },
        { from: 'b', to: 'merge' },
      ],
      outputs: { ok: '{{context.merge.output.branches.a}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'fork_without_join_pair')).toBeUndefined()
  })

  it('fails when no downstream join maps every branch declared by a parallel_fork', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
        { id: 'c', type: 'noop', config: {} },
        { id: 'merge', type: 'join', config: { sources: { a: 'a', b: 'b' } } },
      ],
      edges: [
        { from: 'fork', to: 'a' },
        { from: 'fork', to: 'b' },
        { from: 'fork', to: 'c' },
        { from: 'a', to: 'merge' },
        { from: 'b', to: 'merge' },
        { from: 'c', to: 'merge' },
      ],
      outputs: { ok: '{{context.merge.output.branches.a}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'fork_join_missing_branch_sources',
      severity: 'fail',
      nodeId: 'fork',
    }))
    expect(result.status).toBe('fail')
  })

  it('accepts a downstream join that maps every branch declared by a parallel_fork', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
        { id: 'c', type: 'noop', config: {} },
        { id: 'merge', type: 'join', config: { sources: { a: 'a', b: 'b', c: 'c' } } },
      ],
      edges: [
        { from: 'fork', to: 'a' },
        { from: 'fork', to: 'b' },
        { from: 'fork', to: 'c' },
        { from: 'a', to: 'merge' },
        { from: 'b', to: 'merge' },
        { from: 'c', to: 'merge' },
      ],
      outputs: { ok: '{{context.merge.output.branches.a}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'fork_join_missing_branch_sources')).toBeUndefined()
  })

  it('fails when a join references a predecessor that is not actually upstream', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
        // The third "branch" — `c` — is not wired with an edge to merge.
        { id: 'c', type: 'noop', config: {} },
        { id: 'merge', type: 'join', config: { sources: { a: 'a', b: 'b', c: 'c' } } },
      ],
      edges: [
        { from: 'a', to: 'merge' },
        { from: 'b', to: 'merge' },
      ],
      outputs: { ok: '{{context.merge.output.branches.a}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    const failures = result.issues.filter((issue) => issue.code === 'join_sources_unreachable')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      severity: 'fail',
      nodeId: 'merge',
    })
    expect(failures[0]?.message).toContain('"c"')
    expect(result.status).toBe('fail')
  })

  it('does not fail join_sources_unreachable when every source is wired to the join', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
        { id: 'merge', type: 'join', config: { sources: { a: 'a', b: 'b' } } },
      ],
      edges: [
        { from: 'a', to: 'merge' },
        { from: 'b', to: 'merge' },
      ],
      outputs: { ok: '{{context.merge.output.branches.a}}' },
    })
    const result = checkWorkflowReadiness(workflow)
    expect(result.issues.find((issue) => issue.code === 'join_sources_unreachable')).toBeUndefined()
  })
})
