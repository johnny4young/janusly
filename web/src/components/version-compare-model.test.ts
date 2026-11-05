import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '../types'
import { buildVersionCompare } from './version-compare-model'

const before: WorkflowDefinition = {
  id: 'wf',
  name: 'Orders',
  nodes: [
    { id: 'shape', type: 'transform', config: {} },
    { id: 'call', type: 'http', config: { url: 'https://example.com', retry: { maxAttempts: 1 } } },
    { id: 'old', type: 'noop', config: {} },
  ],
  edges: [{ id: 'a', from: 'shape', to: 'call' }, { from: 'call', to: 'old' }],
  ui: { positions: { shape: { x: 0, y: 0 }, call: { x: 0, y: 200 }, old: { x: 0, y: 400 } } },
}
const after: WorkflowDefinition = {
  ...before,
  nodes: [
    before.nodes[0],
    { id: 'call', type: 'http', config: { url: 'https://example.com', retry: { maxAttempts: 3 } } },
    { id: 'fresh', type: 'approval', config: {} },
  ],
  edges: [before.edges[0], { from: 'call', to: 'fresh' }],
  ui: { positions: { shape: { x: 0, y: 0 }, call: { x: 0, y: 200 }, fresh: { x: 0, y: 400 } } },
}

describe('buildVersionCompare', () => {
  it('merges both sides and marks each step and path', () => {
    const graph = buildVersionCompare(before, after)
    expect(Object.fromEntries(graph.nodes.map(node => [node.id, node.data.compareMark]))).toEqual({
      shape: undefined, call: 'changed', fresh: 'added', old: 'removed',
    })
    expect(graph.edges.map(edge => [edge.source, edge.target, edge.data?.compareMark])).toEqual([
      ['shape', 'call', undefined],
      ['call', 'fresh', 'added'],
      ['call', 'old', 'removed'],
    ])
    expect(graph.counts).toEqual({ added: 2, changed: 1, removed: 2 })
    expect(graph.changes).toHaveLength(5)
  })

  it('gives every merged edge its own canvas id when both sides use index ids', () => {
    const ids = buildVersionCompare(before, after).edges.map(edge => edge.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('moves a deleted step off a step now sitting in its place', () => {
    const graph = buildVersionCompare(before, after)
    const position = (id: string) => graph.nodes.find(node => node.id === id)!.position
    expect(position('fresh')).toEqual({ x: 0, y: 400 })
    expect(position('old')).toEqual({ x: 260, y: 400 })
  })

  it('carries before and after JSON only for the sides that exist', () => {
    const { changes } = buildVersionCompare(before, after)
    const find = (id: string) => changes.find(change => change.canvasId === id)!
    expect(find('call').beforeJson).toContain('"maxAttempts": 1')
    expect(find('call').afterJson).toContain('"maxAttempts": 3')
    expect(find('fresh').beforeJson).toBeUndefined()
    expect(find('old').afterJson).toBeUndefined()
  })

  it('masks sensitive keys, secret templates and credential shapes in the JSON', () => {
    const literal = `sk-ant-${'x'.repeat(32)}`
    const secretful: WorkflowDefinition = {
      ...before,
      nodes: [{
        id: 'call',
        type: 'http',
        config: {
          retry: { apiKey: 'retry-nested-value' },
          headers: { Authorization: 'plain-value', 'x-custom': '{{secret.ORDERS}}' },
          list: [{ token: 'list-value' }],
          body: `prefix ${literal}`,
          url: 'https://example.com',
        },
      }],
      edges: [],
    }
    const { changes } = buildVersionCompare({ ...before, nodes: [], edges: [] }, secretful)
    const json = changes.find(change => change.canvasId === 'call')!.afterJson!
    for (const raw of ['retry-nested-value', 'plain-value', 'ORDERS', 'list-value', literal]) {
      expect(json).not.toContain(raw)
    }
    expect(json).toContain('https://example.com')
  })

  it('reports nothing for two identical versions', () => {
    const graph = buildVersionCompare(before, before)
    expect(graph.changes).toEqual([])
    expect(graph.nodes.every(node => node.data.compareMark === undefined)).toBe(true)
  })
})
