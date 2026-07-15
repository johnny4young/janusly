import { describe, expect, it } from 'vitest'
import { getRunWorkflowSnapshot, projectVisibleEdges, projectVisibleNodes, workflowToGraph, WORKFLOW_EDGE_MARKER_END } from './canvas-projections'
import type { WorkflowGraphEdge, WorkflowGraphNode } from './types'

const baseEdge = (id: string, extra: Partial<WorkflowGraphEdge> = {}): WorkflowGraphEdge => ({
  id,
  source: `${id}-src`,
  target: `${id}-tgt`,
  data: {},
  ...extra,
})

const baseNode = (id: string, type = 'http', extra: Partial<WorkflowGraphNode> = {}): WorkflowGraphNode => ({
  id,
  position: { x: 0, y: 0 },
  data: { label: '', type, config: {} },
  ...extra,
})

describe('getRunWorkflowSnapshot', () => {
  const validWorkflow = {
    id: 'wf-valid',
    name: 'Valid workflow',
    inputs: {
      type: 'object',
      properties: { invoiceId: { type: 'string' } },
      required: ['invoiceId'],
    },
    outputs: { result: '{{context.finish.output}}' },
    ui: { positions: { finish: { x: 240, y: 90 } } },
    nodes: [{ id: 'finish', type: 'noop', label: 'Finish billing', config: {} }],
    edges: [],
  }

  it('accepts the complete workflow shape used by drafts and run snapshots', () => {
    expect(getRunWorkflowSnapshot({ workflow: validWorkflow })).toBe(validWorkflow)
  })

  it('accepts the closed template policy and rejects malformed historical values', () => {
    const strict = { ...validWorkflow, templatePolicy: 'strict' }
    expect(getRunWorkflowSnapshot({ workflow: strict })).toBe(strict)
    expect(getRunWorkflowSnapshot({ workflow: { ...validWorkflow, templatePolicy: 'warn' } })).toBeNull()
  })

  it.each([
    { ...validWorkflow, id: '' },
    { ...validWorkflow, name: 42 },
    { ...validWorkflow, inputs: { type: 'object', properties: { invoiceId: null } } },
    { ...validWorkflow, inputs: { type: 'date' } },
    { ...validWorkflow, outputs: { result: null } },
    { ...validWorkflow, ui: { positions: { finish: { x: Number.NaN, y: 0 } } } },
    { ...validWorkflow, ui: { positions: { missing: { x: 0, y: 0 } } } },
    { ...validWorkflow, nodes: [{ id: 'finish', type: 'noop', label: 'x'.repeat(81), config: {} }] },
    { ...validWorkflow, nodes: [{ id: 'finish', type: 'noop', label: `${' '.repeat(80)}x`, config: {} }] },
    { ...validWorkflow, edges: [{ from: 'finish', to: 'finish', condition: '' }] },
  ])('rejects a malformed top-level or input/output shape', workflow => {
    expect(getRunWorkflowSnapshot({ workflow })).toBeNull()
  })

  it('does not invent a position-count cap absent from the canonical workflow contract', () => {
    const nodes = Array.from({ length: 10_001 }, (_, index) => ({
      id: `node-${index}`,
      type: 'noop',
      config: {},
    }))
    const positions = Object.fromEntries(nodes.map((node, index) => [node.id, { x: index, y: index }]))
    const workflow = { nodes, edges: [], ui: { positions } }

    expect(getRunWorkflowSnapshot({ workflow })).toBe(workflow)
  })
})

describe('projectVisibleEdges', () => {
  it('sets type, animated, and hasCondition based on the data.condition flag', () => {
    const edges = [
      baseEdge('a', { data: { condition: 'x > 0' } }),
      baseEdge('b', { data: {} }),
    ]
    const [withCondition, withoutCondition] = projectVisibleEdges(edges, null)
    expect(withCondition.type).toBe('workflowEdge')
    expect(withCondition.animated).toBe(true)
    expect((withCondition.data as { hasCondition?: boolean }).hasCondition).toBe(true)
    expect(withoutCondition.animated).toBe(false)
    expect((withoutCondition.data as { hasCondition?: boolean }).hasCondition).toBe(false)
  })

  it('flags only the edge matching selectedEdgeId as selected', () => {
    const edges = [baseEdge('a'), baseEdge('b'), baseEdge('c')]
    const projected = projectVisibleEdges(edges, 'b')
    expect(projected.map((e) => e.selected)).toEqual([false, true, false])
  })

  it('produces deeply equal output when called twice with the same inputs', () => {
    const edges = [baseEdge('a'), baseEdge('b', { data: { condition: 'y < 5' } })]
    expect(projectVisibleEdges(edges, 'a')).toEqual(projectVisibleEdges(edges, 'a'))
  })

  it('does NOT carry a label string — the condition label is resolved inside WorkflowEdge', () => {
    const edges = [baseEdge('a', { data: { condition: 'z !== null' } })]
    const [projected] = projectVisibleEdges(edges, null)
    // The projection must not embed a locale-dependent label; that
    // would leak `t` into the upstream memo's dep array.
    expect((projected as { label?: unknown }).label).toBeUndefined()
  })

  it('omits style and reuses a stable markerEnd object so arrowheads stay visible', () => {
    const edges = [baseEdge('a')]
    const [first] = projectVisibleEdges(edges, 'a')
    const [second] = projectVisibleEdges(edges, 'a')
    expect((first as { style?: unknown }).style).toBeUndefined()
    expect(first.markerEnd).toBe(WORKFLOW_EDGE_MARKER_END)
    expect(second.markerEnd).toBe(WORKFLOW_EDGE_MARKER_END)
  })
})

describe('workflowToGraph', () => {
  it('preserves persisted order in the established deterministic authoring layout', () => {
    const graph = workflowToGraph({
      id: 'billing',
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'left', type: 'http', config: {} },
        { id: 'right', type: 'ai', config: {} },
        { id: 'finish', type: 'approval', config: {} },
      ],
      edges: [
        { from: 'start', to: 'left' },
        { from: 'start', to: 'right' },
        { from: 'left', to: 'finish' },
        { from: 'right', to: 'finish' },
      ],
    })

    expect(graph.nodes.map(node => ({ id: node.id, position: node.position }))).toEqual([
      { id: 'start', position: { x: 80, y: 80 } },
      { id: 'left', position: { x: 310, y: 200 } },
      { id: 'right', position: { x: 540, y: 320 } },
      { id: 'finish', position: { x: 770, y: 80 } },
    ])
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['start', 'left'],
      ['start', 'right'],
      ['left', 'finish'],
      ['right', 'finish'],
    ])
  })

  it('keeps cyclic nodes visible because layout never drops persisted evidence', () => {
    const graph = workflowToGraph({
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'noop', config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    })
    expect(graph.nodes.map(node => node.position)).toEqual([
      { x: 80, y: 80 },
      { x: 310, y: 200 },
    ])
  })

  it('restores persisted positions and custom labels while falling back per node', () => {
    const graph = workflowToGraph({
      nodes: [
        { id: 'placed', type: 'noop', label: 'Review invoice', config: {} },
        { id: 'fallback', type: 'http', config: {} },
      ],
      edges: [],
      ui: { positions: { placed: { x: 777, y: 333 } } },
    })

    expect(graph.nodes[0].position).toEqual({ x: 777, y: 333 })
    expect(graph.nodes[0].data.label).toBe('Review invoice')
    expect(graph.nodes[1].position).toEqual({ x: 310, y: 200 })
    expect(graph.nodes[1].data.label).toBe('')
  })
})

describe('projectVisibleNodes', () => {
  it('reads status from the statusMap and falls back to pending when missing', () => {
    const nodes = [baseNode('a'), baseNode('b'), baseNode('c')]
    const statusMap = new Map<string, 'pending' | 'running'>([
      ['a', 'running'],
      ['b', 'pending'],
    ])
    const projected = projectVisibleNodes(nodes, statusMap, [], null)
    expect(projected.map((n) => (n.data as { status?: string }).status)).toEqual(['running', 'pending', 'pending'])
  })

  it('flags hasValidationError on nodes that appear in the issue list', () => {
    const nodes = [baseNode('a'), baseNode('b')]
    const issues = [{ nodeId: 'b' }]
    const projected = projectVisibleNodes(nodes, new Map(), issues, null)
    expect((projected[0].data as { hasValidationError?: boolean }).hasValidationError).toBe(false)
    expect((projected[1].data as { hasValidationError?: boolean }).hasValidationError).toBe(true)
  })

  it('does NOT pre-resolve label or helper — WorkflowStepNode reads getNodeLabel/getNodeHelper at render time', () => {
    const nodes = [baseNode('a', 'http')]
    const [projected] = projectVisibleNodes(nodes, new Map(), [], null)
    // The projection inherits `data.label` from the input via the spread,
    // but does not OVERWRITE it with a t()-resolved string. Inputs from
    // the editor carry `label: ''` (empty), so the WorkflowStepNode
    // fallback resolves the label via `getNodeLabel(type)` at render
    // time, which lets the i18n.language dep drop from the upstream memo.
    expect((projected.data as { label: string }).label).toBe('')
  })
})
