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

  it('accepts a bounded custom label and rejects empty or overlong labels', () => {
    expect(NodeSchema.safeParse({ id: 'n1', type: 'noop', label: 'Review invoice' }).success).toBe(true)
    expect(NodeSchema.safeParse({ id: 'n1', type: 'noop', label: '   ' }).success).toBe(false)
    expect(NodeSchema.safeParse({ id: 'n1', type: 'noop', label: 'x'.repeat(81) }).success).toBe(false)
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

  it('accepts only the closed unresolved-template policies without defaulting legacy workflows', () => {
    const base = { nodes: [], edges: [] }
    expect(WorkflowSchema.parse(base)).not.toHaveProperty('templatePolicy')
    expect(WorkflowSchema.parse({ ...base, templatePolicy: 'lenient' }).templatePolicy).toBe('lenient')
    expect(WorkflowSchema.parse({ ...base, templatePolicy: 'strict' }).templatePolicy).toBe('strict')
    expect(WorkflowSchema.safeParse({ ...base, templatePolicy: 'warn' }).success).toBe(false)
  })

  it('accepts finite editor positions and rejects non-finite coordinates', () => {
    const workflow = {
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
      ui: { positions: { start: { x: 240, y: -12.5 } } },
    }
    expect(WorkflowSchema.safeParse(workflow).success).toBe(true)
    expect(WorkflowSchema.safeParse({
      ...workflow,
      ui: { positions: { start: { x: Number.POSITIVE_INFINITY, y: 0 } } },
    }).success).toBe(false)
  })

  it('rejects editor positions that do not reference a workflow node', () => {
    expect(WorkflowSchema.safeParse({
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
      ui: { positions: { missing: { x: 0, y: 0 } } },
    }).success).toBe(false)
  })

  it('preserves validated workflow recovery settings', () => {
    const workflow = WorkflowSchema.parse({
      nodes: [{ id: 'charge', type: 'http', config: {} }],
      edges: [],
      recovery: {
        circuitBreaker: { consecutiveFailures: 5 },
        contract: {
          version: '1',
          failure: {
            technical: { terminalNodeFailure: true, stalledNode: true },
            semantic: { mode: 'disabled' },
          },
          evidence: {
            required: [
              'failure_snapshot',
              'audit_trail',
              'validation_receipt',
              'terminal_outcome',
            ],
          },
          effects: [{
            nodeId: 'charge',
            kind: 'external_write',
            idempotency: 'required',
            receipt: 'runtime',
          }],
          repairs: { allowed: ['retry', 'config_patch'] },
          validation: { minimumEvidenceLevel: 'writes_skipped' },
          approval: {
            productionMutation: 'required',
            permission: 'recovery.write',
          },
          autonomyLevel: 3,
          verification: {
            kind: 'generation_bound_terminal_success',
          },
          recurrence: { windowDays: 7 },
        },
      },
    })
    expect(workflow.recovery?.circuitBreaker).toEqual({
      consecutiveFailures: 5,
    })
    expect(workflow.recovery?.contract?.version).toBe('1')
  })

  it('rejects recovery effects that reference missing workflow nodes', () => {
    const parsed = WorkflowSchema.safeParse({
      nodes: [{ id: 'charge', type: 'http', config: {} }],
      edges: [],
      recovery: {
        contract: {
          version: '1',
          failure: {
            technical: { terminalNodeFailure: true, stalledNode: true },
            semantic: { mode: 'disabled' },
          },
          evidence: {
            required: [
              'failure_snapshot',
              'audit_trail',
              'terminal_outcome',
            ],
          },
          effects: [{
            nodeId: 'missing',
            kind: 'external_write',
            idempotency: 'required',
            receipt: 'runtime',
          }],
          repairs: { allowed: ['retry'] },
          validation: { minimumEvidenceLevel: 'static' },
          approval: {
            productionMutation: 'required',
            permission: 'recovery.write',
          },
          autonomyLevel: 1,
          verification: {
            kind: 'generation_bound_terminal_success',
          },
          recurrence: { windowDays: 7 },
        },
      },
    })
    expect(parsed.success).toBe(false)
  })
})
