import { describe, expect, it } from 'vitest'
import { validateWorkflow } from './workflow-validation'

describe('validateWorkflow', () => {
  it('validates a minimal executable workflow', () => {
    const result = validateWorkflow({
      id: 'wf_valid',
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    })

    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('detects cycles and edges pointing to non-existent nodes', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'b', to: 'c' },
      ],
    })

    expect(result.valid).toBe(false)
    const codes = result.issues.map(issue => issue.code)
    expect(codes).toContain('cycle_detected')
    expect(codes).toContain('edge_invalid_to')
  })

  it('validates required tool inputs', () => {
    const result = validateWorkflow({
      nodes: [{ id: 'tool', type: 'tool', config: { tool: 'text.uppercase', input: {} } }],
      edges: [],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'tool_invalid_input', nodeId: 'tool' }))
  })

  it('skips the per-tool input check when strictToolInputs: false (AI Studio draft path)', () => {
    // Workflow has the same incomplete tool node as the test above —
    // when the draft-generation surface validates it (with the option
    // flipped), the tool_invalid_input issue MUST NOT fire so the
    // operator's draft can carry partial inputs into the Inspector.
    const result = validateWorkflow(
      {
        nodes: [{ id: 'email', type: 'tool', config: { tool: 'email.send', input: {} } }],
        edges: [],
      },
      { strictToolInputs: false },
    )

    expect(result.valid).toBe(true)
    expect(result.issues.find(issue => issue.code === 'tool_invalid_input')).toBeUndefined()
  })

  it('still flags tool_missing_name when strictToolInputs: false', () => {
    // The structural `tool_missing_name` check is independent of the
    // per-input gate — a tool node with no `tool` field is invalid in
    // both strict and draft modes.
    const result = validateWorkflow(
      {
        nodes: [{ id: 'tool', type: 'tool', config: {} }],
        edges: [],
      },
      { strictToolInputs: false },
    )

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'tool_missing_name', nodeId: 'tool' }))
    expect(result.issues.find(issue => issue.code === 'tool_invalid_input')).toBeUndefined()
  })

  it('still rejects unknown tool names when strictToolInputs: false', () => {
    // Draft mode only skips per-tool input completeness. It must still
    // reject unknown tool names so malformed AI output falls back instead
    // of landing as a runtime-invalid workflow in the Inspector.
    const result = validateWorkflow(
      {
        nodes: [{ id: 'tool', type: 'tool', config: { tool: 'gmail.search', input: {} } }],
        edges: [],
      },
      { strictToolInputs: false },
    )

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'tool_invalid_input',
      message: 'Unknown tool: gmail.search',
      nodeId: 'tool',
    }))
  })

  it('rejects empty workflows', () => {
    const result = validateWorkflow({ nodes: [], edges: [] })
    expect(result.valid).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('empty_workflow')
  })

  it('detects duplicate nodes, http without url, and empty multi_agent', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'n1', type: 'http', config: {} },
        { id: 'n1', type: 'noop', config: {} },
        { id: 'crew', type: 'multi_agent', config: { agents: [] } },
      ],
      edges: [],
    })

    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('duplicate_node_id')
    expect(codes).toContain('http_missing_url')
    expect(codes).toContain('multi_agent_missing_agents')
  })

  it('detects ai nodes without a prompt, agent nodes without a goal, and transform nodes without a mapping', () => {
    // Future AI generation strategies may produce looser node shapes,
    // and direct operator input can still submit malformed configs, so
    // this validator is the strict runtime gate for required fields.
    // Pin each rejection so the gate doesn't drift back to permissive.
    const result = validateWorkflow({
      nodes: [
        { id: 'summarize', type: 'ai', config: {} },
        { id: 'analyst', type: 'agent', config: {} },
        { id: 'shape', type: 'transform', config: {} },
        { id: 'shape_empty', type: 'transform', config: { mapping: {} } },
      ],
      edges: [],
    })

    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('ai_missing_prompt')
    expect(codes).toContain('agent_missing_goal')
    expect(codes.filter(c => c === 'transform_missing_mapping').length).toBe(2)
  })

  it('validates human_form schema before runtime execution', () => {
    const invalid = validateWorkflow({
      nodes: [
        { id: 'form_missing', type: 'human_form', config: {} },
        { id: 'form_empty', type: 'human_form', config: { schema: { type: 'object', properties: {} } } },
      ],
      edges: [],
    })

    expect(invalid.valid).toBe(false)
    expect(invalid.issues).toContainEqual(expect.objectContaining({ code: 'human_form_invalid_schema', nodeId: 'form_missing' }))
    expect(invalid.issues).toContainEqual(expect.objectContaining({ code: 'human_form_empty_schema', nodeId: 'form_empty' }))

    const valid = validateWorkflow({
      nodes: [{
        id: 'collect',
        type: 'human_form',
        config: {
          schema: {
            type: 'object',
            properties: {
              requester: { type: 'string' },
              days: { type: 'number' },
            },
            required: ['requester'],
          },
        },
      }],
      edges: [],
    })

    expect(valid).toEqual({ valid: true, issues: [] })
  })

  it('rejects malformed parallel_fork and join config before runtime execution', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'fork', type: 'parallel_fork', config: { branches: [{ label: 'only' }] } },
        { id: 'merge', type: 'join', config: { sources: { a: 'fork' } } },
      ],
      edges: [{ from: 'fork', to: 'merge' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'parallel_fork_invalid_branches',
      nodeId: 'fork',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'join_invalid_sources',
      nodeId: 'merge',
    }))
  })

  it('accepts valid parallel_fork and join config at the structural validation layer', () => {
    const result = validateWorkflow({
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
    })

    expect(result.issues.find(issue => issue.code === 'parallel_fork_invalid_branches')).toBeUndefined()
    expect(result.issues.find(issue => issue.code === 'join_invalid_sources')).toBeUndefined()
  })

  it('rejects schedule nodes with a missing or malformed cron expression', () => {
    const missing = validateWorkflow({
      nodes: [{ id: 'trigger', type: 'schedule', config: {} }],
      edges: [],
    })
    expect(missing.valid).toBe(false)
    expect(missing.issues).toContainEqual(expect.objectContaining({
      code: 'schedule_invalid_cron',
      nodeId: 'trigger',
    }))

    const malformed = validateWorkflow({
      nodes: [{ id: 'trigger', type: 'schedule', config: { cronExpression: 'wat' } }],
      edges: [],
    })
    expect(malformed.valid).toBe(false)
    expect(malformed.issues).toContainEqual(expect.objectContaining({
      code: 'schedule_invalid_cron',
      nodeId: 'trigger',
    }))

    const badEnabled = validateWorkflow({
      nodes: [{ id: 'trigger', type: 'schedule', config: { cronExpression: '0 9 * * *', enabled: 'yes' } }],
      edges: [],
    })
    expect(badEnabled.issues).toContainEqual(expect.objectContaining({
      code: 'schedule_invalid_cron',
      nodeId: 'trigger',
    }))
  })

  it('rejects wait_until nodes with missing, malformed, or non-positive duration', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'wait_missing', type: 'wait_until', config: {} },
        { id: 'wait_words', type: 'wait_until', config: { duration: '3 days' } },
        { id: 'wait_zero', type: 'wait_until', config: { duration: 'PT0S' } },
      ],
      edges: [],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'wait_until_missing_duration',
      nodeId: 'wait_missing',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'wait_until_invalid_duration',
      nodeId: 'wait_words',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'wait_until_non_positive_duration',
      nodeId: 'wait_zero',
    }))
  })

  it('accepts wait_until nodes with a positive ISO 8601 duration', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'wait', type: 'wait_until', config: { duration: 'P3D' } },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'wait', to: 'next' }],
    })

    expect(result.issues.find(issue => issue.code.startsWith('wait_until_'))).toBeUndefined()
  })

  it('accepts schedule nodes with a valid cron expression', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'trigger', type: 'schedule', config: { cronExpression: '*/5 * * * *', enabled: true } },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'trigger', to: 'next' }],
    })
    expect(result.issues.find(issue => issue.code === 'schedule_invalid_cron')).toBeUndefined()
  })

  it('accepts ai/agent/transform nodes when their required fields are present', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'summarize', type: 'ai', config: { prompt: 'summarize the article' } },
        { id: 'analyst', type: 'agent', config: { goal: 'analyze the data' } },
        { id: 'shape', type: 'transform', config: { mapping: { out: '{{context.summarize.output}}' } } },
      ],
      edges: [
        { from: 'summarize', to: 'analyst' },
        { from: 'analyst', to: 'shape' },
      ],
    })

    const codes = result.issues.map(i => i.code)
    expect(codes).not.toContain('ai_missing_prompt')
    expect(codes).not.toContain('agent_missing_goal')
    expect(codes).not.toContain('transform_missing_mapping')
  })

  it('validates expressions on condition nodes and edge conditions', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'check', type: 'condition', config: { expression: 'process.exit()' } },
      ],
      edges: [{ from: 'a', to: 'check', condition: 'process.exit()' }],
    })

    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('condition_invalid_expression')
    expect(codes).toContain('edge_invalid_condition')
  })

  it('requires a start node when every node has incoming edges', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })

    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('missing_start_node')
  })

  it('rejects router nodes with empty candidates', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [] } },
      ],
      edges: [{ from: 'start', to: 'pick' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'router_missing_candidates',
      nodeId: 'pick',
    }))
  })

  it('accepts router nodes with the canonical { nodeId } candidate shape', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'fast' }] } },
        { id: 'fast', type: 'noop', config: {} },
      ],
      edges: [{ from: 'start', to: 'pick' }],
    })

    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('accepts router_llm nodes with the legacy { id } candidate shape (back-compat)', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router_llm', config: { candidates: [{ id: 'legacy_path' }] } },
        { id: 'legacy_path', type: 'noop', config: {} },
      ],
      edges: [{ from: 'start', to: 'pick' }],
    })

    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('rejects router candidates that carry neither nodeId nor a legacy id', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [{}] } },
      ],
      edges: [{ from: 'start', to: 'pick' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'router_candidate_missing_node_id',
      nodeId: 'pick',
    }))
  })

  it('rejects router candidates that reference an unknown node id', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'missing_path' }] } },
      ],
      edges: [{ from: 'start', to: 'pick' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'router_candidate_unknown_node_id',
      nodeId: 'pick',
    }))
  })
})
