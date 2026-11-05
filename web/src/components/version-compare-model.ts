import type { Edge, Node } from '@xyflow/react'
import { projectVisibleEdges, workflowToGraph } from '../canvas-projections'
import { scrubOperatorGuidanceSecrets } from '../lib/operator-guidance'
import { SENSITIVE_KEY_PATTERN } from '../lib/sensitive-keys'
import { computeWorkflowDiff, edgeKeyFor, SECRET_TEMPLATE_PATTERN } from '../lib/workflow-diff'
import type { WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from '../types'

export type CompareMark = 'added' | 'changed' | 'removed'
export type CompareGraphNode = Node<WorkflowGraphNode['data'] & { compareMark?: CompareMark }>
export type CompareGraphEdge = Edge<NonNullable<WorkflowGraphEdge['data']> & { compareMark?: CompareMark }>
export type CompareChange = {
  target: 'node' | 'edge'
  canvasId: string
  mark: CompareMark
  /** Steps to frame when this change is focused. */
  nodeIds: string[]
  /** Masked pretty JSON; absent on the side where the element does not exist. */
  beforeJson?: string
  afterJson?: string
}

const REDACTED = '[redacted]'
const NODE_FOOTPRINT = { width: 260, height: 170 }

/** Saved versions may hold literal credentials, so the JSON view masks like the field diff does. */
function maskSecrets(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED
  if (typeof value === 'string') return SECRET_TEMPLATE_PATTERN.test(value) ? REDACTED : scrubOperatorGuidanceSecrets(value)
  if (Array.isArray(value)) return value.map(item => maskSecrets(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, maskSecrets(child, childKey)]))
  }
  return value
}

const maskedJson = (value: unknown) => JSON.stringify(maskSecrets(value), null, 2)

/** A deleted step keeps its old position unless a step of the newer side now sits there. */
function placeRemoved(position: { x: number; y: number }, placed: { x: number; y: number }[]) {
  const next = { ...position }
  while (placed.some(other => Math.abs(other.x - next.x) < NODE_FOOTPRINT.width && Math.abs(other.y - next.y) < NODE_FOOTPRINT.height)) {
    next.x += NODE_FOOTPRINT.width
  }
  return next
}

/** Merge both sides into one graph: the newer side plus what it deleted, each element marked. */
export function buildVersionCompare(before: WorkflowDefinition, after: WorkflowDefinition) {
  const diff = computeWorkflowDiff(before, after)
  const beforeGraph = workflowToGraph(before)
  const afterGraph = workflowToGraph(after)
  const changes: CompareChange[] = []

  const nodeMarks = new Map<string, CompareMark>()
  for (const change of diff.nodes) {
    const id = change.kind === 'changed' ? change.nodeId : change.node.id
    nodeMarks.set(id, change.kind)
    changes.push({
      target: 'node', canvasId: id, mark: change.kind, nodeIds: [id],
      ...(change.kind === 'added' ? {} : { beforeJson: maskedJson(change.kind === 'removed' ? change.node : change.before) }),
      ...(change.kind === 'removed' ? {} : { afterJson: maskedJson(change.kind === 'added' ? change.node : change.after) }),
    })
  }

  const placed = afterGraph.nodes.map(node => node.position)
  const removedNodes = beforeGraph.nodes.filter(node => nodeMarks.get(node.id) === 'removed').map((node) => {
    const position = placeRemoved(node.position, placed)
    placed.push(position)
    return { ...node, position }
  })
  const nodes: CompareGraphNode[] = [...afterGraph.nodes, ...removedNodes].map(node => ({
    ...node,
    type: 'versionCompareStep',
    data: { ...node.data, compareMark: nodeMarks.get(node.id) },
  }))

  const edgeChanges = new Map(diff.edges.map(change => [change.edgeKey, change]))
  const edges: CompareGraphEdge[] = []
  const addEdges = (graphEdges: WorkflowGraphEdge[], sourceEdges: WorkflowDefinition['edges'], side: 'before' | 'after') => {
    graphEdges.forEach((edge, index) => {
      const change = edgeChanges.get(edgeKeyFor(sourceEdges[index]))
      if (side === 'before' && change?.kind !== 'removed') return
      // Both sides fall back to index-based canvas ids, so a deleted edge needs its own namespace.
      const canvasId = side === 'before' ? `removed:${edge.id}` : edge.id
      edges.push({ ...edge, id: canvasId, data: { ...edge.data, compareMark: change?.kind } })
      if (!change) return
      changes.push({
        target: 'edge', canvasId, mark: change.kind, nodeIds: [edge.source, edge.target],
        ...(change.kind === 'added' ? {} : { beforeJson: maskedJson(change.kind === 'removed' ? change.edge : change.before) }),
        ...(change.kind === 'removed' ? {} : { afterJson: maskedJson(change.kind === 'added' ? change.edge : change.after) }),
      })
    })
  }
  addEdges(afterGraph.edges, after.edges, 'after')
  addEdges(beforeGraph.edges, before.edges, 'before')

  const count = (mark: CompareMark) => changes.filter(change => change.mark === mark).length
  return {
    nodes,
    edges: (projectVisibleEdges(edges, null) as CompareGraphEdge[]).map(edge => ({ ...edge, type: 'versionCompareEdge' })),
    changes,
    counts: { added: count('added'), changed: count('changed'), removed: count('removed') },
  }
}
