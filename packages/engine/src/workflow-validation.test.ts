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
