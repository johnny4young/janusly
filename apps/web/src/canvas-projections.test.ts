import { describe, expect, it } from 'vitest'
import { projectVisibleEdges, projectVisibleNodes, WORKFLOW_EDGE_MARKER_END } from './canvas-projections'
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
