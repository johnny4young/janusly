import { describe, expect, it } from 'vitest'
import { EdgeSchema, NodeSchema, WorkflowSchema, nodeTypeValues } from './workflow'

describe('NodeSchema', () => {
  it('rejects nodes without an id', () => {
    const result = NodeSchema.safeParse({ id: '', type: 'noop', config: {} })
    expect(result.success).toBe(false)
  })

  it('defaults config to an empty object', () => {
    const result = NodeSchema.safeParse({ id: 'n1', type: 'noop' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.config).toEqual({})
  })
})

describe('EdgeSchema', () => {
  it('requires both source and target', () => {
    expect(EdgeSchema.safeParse({ from: 'a', to: 'b' }).success).toBe(true)
    expect(EdgeSchema.safeParse({ from: '', to: 'b' }).success).toBe(false)
    expect(EdgeSchema.safeParse({ from: 'a', to: '' }).success).toBe(false)
  })
})

describe('WorkflowSchema', () => {
  it('accepts a minimal DAG with supported node types', () => {
    const result = WorkflowSchema.safeParse({
      id: 'workflow_1',
      name: 'Daily pipeline',
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    })

    expect(result.success).toBe(true)
  })

  it('rejects node types that are outside the shared contract', () => {
    const result = WorkflowSchema.safeParse({
      nodes: [{ id: 'start', type: 'unknown', config: {} }],
      edges: [],
    })

    expect(result.success).toBe(false)
  })

  it('keeps the published list of types as a stable contract', () => {
    expect(nodeTypeValues).toContain('multi_agent')
    expect(nodeTypeValues).toContain('approval')
    expect(nodeTypeValues).toContain('human_form')
    expect(nodeTypeValues).toContain('noop')
    expect(nodeTypeValues).toContain('http')
    expect(nodeTypeValues).toContain('tool')
    expect(nodeTypeValues).toContain('agent_reflection')
  })

  it('accepts workflows without id or name (client-side drafts)', () => {
    const result = WorkflowSchema.safeParse({ nodes: [], edges: [] })
    expect(result.success).toBe(true)
  })
})
