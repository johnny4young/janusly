import { describe, expect, it } from 'vitest'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import {
  buildExpressionSuggestions,
  collectReachableUpstreamNodeIds,
  findUnresolvedExpressionReferences,
} from './expression-context'

const nodes = [
  { id: 'fetch', data: { type: 'http', config: {} } },
  { id: 'shape', data: { type: 'transform', config: { mapping: { total: '{{context.fetch.output.body.total}}' } } } },
  { id: 'gate', data: { type: 'condition', config: {} } },
  { id: 'isolated', data: { type: 'http', config: {} } },
].map((node, index) => ({ ...node, position: { x: index * 10, y: 0 } })) as WorkflowGraphNode[]

const edges: WorkflowGraphEdge[] = [
  { id: 'fetch-shape', source: 'fetch', target: 'shape', data: {} },
  { id: 'shape-gate', source: 'shape', target: 'gate', data: {} },
]

describe('expression graph context', () => {
  it('offers only transitive predecessors for a node expression', () => {
    expect(collectReachableUpstreamNodeIds({ nodes, edges, targetNodeId: 'gate' })).toEqual(['fetch', 'shape'])
    const tokens = buildExpressionSuggestions({ nodes, edges, targetNodeId: 'gate', mode: 'node' }).map((item) => item.token)
    expect(tokens).toContain('context.fetch.output.statusCode')
    expect(tokens).toContain('context.fetch.output.json')
    expect(tokens).toContain('context.fetch.output.jsonParseSkipped')
    expect(tokens).toContain('context.shape.output.total')
    expect(tokens).not.toContain('context.gate.output')
    expect(tokens).not.toContain('context.isolated.output')
  })

  it('includes the source node itself for an edge condition', () => {
    const tokens = buildExpressionSuggestions({ nodes, edges, targetNodeId: 'shape', mode: 'edge' }).map((item) => item.token)
    expect(tokens).toContain('context.fetch.output')
    expect(tokens).toContain('context.shape.output.total')
    expect(tokens).not.toContain('inputs')
  })

  it('flattens declared workflow inputs without exposing secret/env paths or removed nodes', () => {
    const suggestions = buildExpressionSuggestions({
      nodes: nodes.filter((node) => node.id !== 'shape'),
      edges: edges.filter((edge) => edge.source !== 'shape' && edge.target !== 'shape'),
      targetNodeId: 'gate',
      mode: 'node',
      workflowInputs: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          customer: { type: 'object', properties: { tier: { type: 'string' } } },
        },
      },
    })
    const tokens = suggestions.map((item) => item.token)

    expect(tokens).toContain('context.input.amount')
    expect(tokens).toContain('context.input.customer.tier')
    expect(tokens.some((token) => token.includes('shape'))).toBe(false)
    expect(tokens.some((token) => /secret|env\./i.test(token))).toBe(false)
    expect(findUnresolvedExpressionReferences('context.isolated.output.ok === true', suggestions, 'node'))
      .toEqual(['context.isolated.output.ok'])
    expect(findUnresolvedExpressionReferences('context.input.missing > 0', suggestions, 'node'))
      .toEqual(['context.input.missing'])
  })

  it('accepts declared array input paths and node-config array indexes', () => {
    const suggestions = buildExpressionSuggestions({
      nodes,
      edges,
      targetNodeId: 'gate',
      mode: 'node',
      workflowInputs: {
        type: 'array',
        items: { type: 'object', properties: { amount: { type: 'number' } } },
      },
    })

    expect(suggestions.map((item) => item.token)).toContain('context.input[0].amount')
    expect(findUnresolvedExpressionReferences('context.input[0].amount > 0', suggestions, 'node')).toEqual([])
    expect(findUnresolvedExpressionReferences('inputs[0].amount > 0', suggestions, 'node')).toEqual([])
    expect(findUnresolvedExpressionReferences('inputs[0].amount > 0', suggestions, 'edge')).toEqual(['inputs[0].amount'])
  })
})
