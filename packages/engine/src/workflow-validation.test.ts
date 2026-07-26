import { describe, expect, it } from 'vitest'
import { workflowVersionMax } from '@janusly/shared'
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

  it('accepts declared input defaults that satisfy their recursive schemas', () => {
    const result = validateWorkflow({
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
      inputs: {
        type: 'object',
        properties: {
          retries: { type: 'number', default: 3 },
          schedule: {
            type: 'object',
            default: { zone: 'UTC' },
            properties: { zone: { type: 'string', default: 'UTC' } },
            required: ['zone'],
          },
        },
      },
    })

    expect(result.issues.filter(issue => issue.code === 'input_default_type_mismatch')).toEqual([])
  })

  it('rejects mismatched defaults at primitive, nested, and array-item paths', () => {
    const result = validateWorkflow({
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
      inputs: {
        type: 'object',
        properties: {
          retries: { type: 'number', default: 'three' },
          schedule: {
            type: 'object',
            properties: { enabled: { type: 'boolean', default: 'yes' } },
          },
          labels: {
            type: 'array',
            items: { type: 'string', default: 42 },
          },
        },
      },
    })

    const defaultIssues = result.issues.filter(issue => issue.code === 'input_default_type_mismatch')
    expect(defaultIssues).toHaveLength(3)
    expect(defaultIssues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('$.retries'),
      expect.stringContaining('$.schedule.enabled'),
      expect.stringContaining('$.labels[]'),
    ]))
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

  it('validates structured AI output schemas and human-form initial values before execution', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'classify', type: 'ai', config: { prompt: 'Classify', outputSchema: { type: 'date' } } },
        {
          id: 'review',
          type: 'human_form',
          config: {
            schema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
              required: ['summary'],
            },
            initialValues: { summary: 42 },
          },
        },
      ],
      edges: [],
    })

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'ai_invalid_output_schema',
      nodeId: 'classify',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'human_form_invalid_initial_values',
      nodeId: 'review',
    }))
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

  it('rejects wait_until nodes with missing, malformed, conflicting, or non-positive timing', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'wait_missing', type: 'wait_until', config: {} },
        { id: 'wait_words', type: 'wait_until', config: { duration: '3 days' } },
        { id: 'wait_zero', type: 'wait_until', config: { duration: 'PT0S' } },
        { id: 'wait_bad_until', type: 'wait_until', config: { until: 'tomorrow' } },
        { id: 'wait_both', type: 'wait_until', config: { duration: 'PT1M', until: '2026-07-14T12:00:00Z' } },
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
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'wait_until_invalid_until',
      nodeId: 'wait_bad_until',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'wait_until_conflicting_time',
      nodeId: 'wait_both',
    }))
  })

  it('accepts wait_until nodes with a positive duration or absolute ISO instant', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'wait', type: 'wait_until', config: { duration: 'P3D' } },
        { id: 'wait_absolute', type: 'wait_until', config: { until: '2026-07-14T12:00:00Z' } },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'wait', to: 'wait_absolute' }, { from: 'wait_absolute', to: 'next' }],
    })

    expect(result.issues.find(issue => issue.code.startsWith('wait_until_'))).toBeUndefined()
  })

  it('rejects malformed approval deadline policies without requiring a deadline for legacy approvals', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'legacy', type: 'approval', config: { message: 'Approve' } },
        { id: 'bad_timeout', type: 'approval', config: { decisionTimeoutMs: 0 } },
        { id: 'bad_escalation', type: 'approval', config: { decisionTimeoutMs: 1000, onTimeout: 'escalate' } },
        { id: 'orphan_policy', type: 'approval', config: { onTimeout: 'auto_reject' } },
      ],
      edges: [],
    })

    expect(result.issues.find(issue => issue.nodeId === 'legacy')).toBeUndefined()
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'approval_invalid_timeout', nodeId: 'bad_timeout' }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'approval_escalation_missing_assignee', nodeId: 'bad_escalation' }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'approval_timeout_policy_without_deadline', nodeId: 'orphan_policy' }))
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

  it('rejects event-driven trigger nodes with a missing or malformed config', () => {
    const missingAlias = validateWorkflow({
      nodes: [
        { id: 'inbox', type: 'email_received', config: {} },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'inbox', to: 'next' }],
    })
    expect(missingAlias.issues.some(i => i.code === 'trigger_invalid_config' && i.nodeId === 'inbox')).toBe(true)

    const missingBucket = validateWorkflow({
      nodes: [
        { id: 'drop', type: 'file_dropped', config: {} },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'drop', to: 'next' }],
    })
    expect(missingBucket.issues.some(i => i.code === 'trigger_invalid_config' && i.nodeId === 'drop')).toBe(true)

    const missingResource = validateWorkflow({
      nodes: [
        { id: 'mcp_evt', type: 'mcp_server_event', config: { connectionAlias: 'notion' } },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'mcp_evt', to: 'next' }],
    })
    expect(missingResource.issues.some(i => i.code === 'trigger_invalid_config' && i.nodeId === 'mcp_evt')).toBe(true)
  })

  it('accepts event-driven trigger nodes with a valid config', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'inbox', type: 'email_received', config: { aliasKey: 'support', dkimRequired: true } },
        { id: 'drop', type: 'file_dropped', config: { bucket: 'inbound', prefix: 'uploads/' } },
        { id: 'mcp_evt', type: 'mcp_server_event', config: { connectionAlias: 'notion', resourceUri: 'notion://db/1' } },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'inbox', to: 'next' },
        { from: 'drop', to: 'next' },
        { from: 'mcp_evt', to: 'next' },
      ],
    })
    expect(result.issues.find(issue => issue.code === 'trigger_invalid_config')).toBeUndefined()
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
      // candidates must be wired as direct successors — the runtime
      // routes the decision by skipping the non-chosen wired candidates.
      edges: [{ from: 'start', to: 'pick' }, { from: 'pick', to: 'fast' }],
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
      edges: [{ from: 'start', to: 'pick' }, { from: 'pick', to: 'legacy_path' }],
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

describe('validateWorkflow — subworkflow composition', () => {
  it('accepts an exact positive version pin', () => {
    const result = validateWorkflow({
      id: 'parent',
      nodes: [{ id: 'child', type: 'subworkflow', config: { workflowId: 'child-flow', version: 2 } }],
      edges: [],
    })

    expect(result).toEqual({ valid: true, issues: [] })
    expect(validateWorkflow({
      id: 'parent',
      nodes: [{ id: 'child', type: 'subworkflow', config: { workflowId: 'child-flow', version: workflowVersionMax } }],
      edges: [],
    })).toEqual({ valid: true, issues: [] })
  })

  it.each([
    [{}, 'subworkflow_missing_workflow'],
    [{ workflowId: 'parent' }, 'subworkflow_self_reference'],
    [{ workflowId: 'child-flow', version: 0 }, 'subworkflow_invalid_version'],
    [{ workflowId: 'child-flow', version: 1.5 }, 'subworkflow_invalid_version'],
    [{ workflowId: 'child-flow', version: workflowVersionMax + 1 }, 'subworkflow_invalid_version'],
    [{ workflowId: 'child-flow', version: '2' }, 'subworkflow_invalid_version'],
    [{ workflowId: ' parent ' }, 'subworkflow_self_reference'],
  ] as const)('rejects malformed composition config %j', (config, expectedCode) => {
    const result = validateWorkflow({
      id: 'parent',
      nodes: [{ id: 'child', type: 'subworkflow', config }],
      edges: [],
    })

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: expectedCode, nodeId: 'child' }))
  })
})

describe('validateWorkflow — bounded loop execution', () => {
  it('accepts the legacy map shape and a bounded per-item tool shape', () => {
    expect(validateWorkflow({
      nodes: [{ id: 'map', type: 'loop', config: { items: 'a,b', mapping: { value: '{{item}}' } } }],
      edges: [],
    })).toEqual({ valid: true, issues: [] })

    expect(validateWorkflow({
      nodes: [{ id: 'batch', type: 'loop', config: {
        mode: 'for_each',
        items: 'a,b',
        tool: 'text.uppercase',
        input: { value: '{{item}}' },
        concurrency: 4,
        toleratedFailurePercentage: 10,
      } }],
      edges: [],
    })).toEqual({ valid: true, issues: [] })
  })

  it.each([
    [{ mode: 'parallel', items: 'a' }, 'loop_invalid_mode'],
    [{ mode: 'for_each', items: 'a' }, 'loop_for_each_missing_tool'],
    [{ mode: 'for_each', items: 'a', tool: 'missing.tool' }, 'loop_for_each_unknown_tool'],
    [{ mode: 'for_each', items: 'a', tool: 'text.uppercase', concurrency: 0 }, 'loop_invalid_concurrency'],
    [{ mode: 'for_each', items: 'a', tool: 'text.uppercase', concurrency: 21 }, 'loop_invalid_concurrency'],
    [{ mode: 'for_each', items: 'a', tool: 'text.uppercase', toleratedFailureCount: 1.5 }, 'loop_invalid_failure_count'],
    [{ mode: 'for_each', items: 'a', tool: 'text.uppercase', toleratedFailurePercentage: 101 }, 'loop_invalid_failure_percentage'],
    [{ mode: 'for_each', items: 'a', tool: 'text.uppercase', toleratedFailureCount: 1, toleratedFailurePercentage: 10 }, 'loop_conflicting_failure_budgets'],
  ] as const)('rejects malformed loop config %j', (config, expectedCode) => {
    const result = validateWorkflow({
      nodes: [{ id: 'batch', type: 'loop', config }],
      edges: [],
    })
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: expectedCode, nodeId: 'batch' }))
  })
})

describe('validateWorkflow — reserved ids + edge scopes', () => {
  it('rejects the reserved node id "input" (collides with the run-input context slot)', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'input', type: 'noop', config: {} },
        { id: 'next', type: 'noop', config: {} },
      ],
      edges: [{ from: 'input', to: 'next' }],
    })

    expect(result.valid).toBe(false)
    const issue = result.issues.find(i => i.code === 'node_id_reserved')
    expect(issue).toBeDefined()
    expect(issue?.nodeId).toBe('input')
  })

  it('rejects inputs.* paths in edge conditions (edges evaluate with an empty inputs scope)', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'inputs.priority === "high"' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('edge_condition_inputs_scope')
  })

  it('also rejects bracket-indexed inputs paths in edge conditions', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'inputs[0].priority === "high"' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('edge_condition_inputs_scope')
  })

  it('does NOT flag a quoted string literal that merely contains "inputs."', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'context.a.output.source === "inputs.file"' }],
    })

    expect(result.issues.map(i => i.code)).not.toContain('edge_condition_inputs_scope')
  })

  it('still accepts context.input.* paths on edges (the sanctioned run-input scope)', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'context.input.priority === "high"' }],
    })

    expect(result.issues.map(i => i.code)).not.toContain('edge_condition_inputs_scope')
  })
})

describe('validateWorkflow — router candidate wiring', () => {
  it('accepts a router whose candidates are wired as direct successors', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'a' }, { nodeId: 'b' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'pick', to: 'a' },
        { from: 'pick', to: 'b' },
      ],
    })

    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('rejects a candidate that is not a direct successor of the router', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'a' }, { nodeId: 'b' }] } },
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'pick', to: 'a' }, { from: 'a', to: 'b' }],
    })

    expect(result.valid).toBe(false)
    const issue = result.issues.find(i => i.code === 'router_candidate_not_successor')
    expect(issue?.nodeId).toBe('pick')
    expect(issue?.message).toContain('"b"')
  })

  it('rejects a candidate that does not exist, honoring the legacy { id } field', () => {
    const result = validateWorkflow({
      nodes: [
        { id: 'pick', type: 'router', config: { candidates: [{ id: 'ghost' }] } },
        { id: 'a', type: 'noop', config: {} },
      ],
      edges: [{ from: 'pick', to: 'a' }],
    })

    expect(result.valid).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('router_candidate_unknown')
  })
})
