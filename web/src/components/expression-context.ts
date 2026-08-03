/** Pure graph projection for safe expression-authoring suggestions. */

import { validateExpression } from '@/lib/expression'
import type { WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'

export type ExpressionValueType = 'string' | 'number' | 'boolean' | 'array' | 'unknown'
export type ExpressionSuggestion = {
  token: string
  kind: 'input' | 'upstream'
  nodeId?: string
  valueType?: ExpressionValueType
}
export type ExpressionAuthoringState =
  | { status: 'empty' }
  | { status: 'valid' }
  | {
      status: 'invalid'
      code: 'invalid_grammar' | 'unresolved'
      references?: string[]
    }

const knownOutputFields: Record<string, string[]> = {
  http: ['statusCode', 'ok', 'body', 'jsonParseError', 'jsonParseSkipped'],
  condition: ['result'],
  loop: ['count'],
  ai: ['mode', 'response'],
  agent: ['result'],
  multi_agent: ['result'],
  wait_until: ['waitedMs'],
}

function collectInputPaths(
  schema: WorkflowInputSchemaShape | undefined,
  prefix = 'context.input',
): Array<{ token: string; valueType: ExpressionValueType }> {
  if (!schema) return []
  if (schema.type === 'object' && schema.properties) {
    return Object.entries(schema.properties).flatMap(([key, child]) => {
      const path = `${prefix}.${key}`
      return [
        { token: path, valueType: expressionValueType(child.type) },
        ...collectInputPaths(child, path),
      ]
    })
  }
  if (schema.type === 'array' && schema.items) {
    const itemPath = `${prefix}[0]`
    return [
      { token: itemPath, valueType: expressionValueType(schema.items.type) },
      ...collectInputPaths(schema.items, itemPath),
    ]
  }
  return []
}

function expressionValueType(type: WorkflowInputSchemaShape['type']): ExpressionValueType {
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'array'
    ? type
    : 'unknown'
}

/** Return only nodes that can have completed before the expression executes. */
export function collectReachableUpstreamNodeIds({
  nodes,
  edges,
  targetNodeId,
  includeTarget = false,
}: {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  targetNodeId: string
  includeTarget?: boolean
}): string[] {
  const existing = new Set(nodes.map((node) => node.id))
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (!existing.has(edge.source) || !existing.has(edge.target)) continue
    const list = incoming.get(edge.target) ?? []
    list.push(edge.source)
    incoming.set(edge.target, list)
  }

  const visited = new Set<string>()
  const stack = includeTarget ? [targetNodeId] : [...(incoming.get(targetNodeId) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current) || !existing.has(current)) continue
    visited.add(current)
    for (const predecessor of incoming.get(current) ?? []) stack.push(predecessor)
  }
  return nodes.map((node) => node.id).filter((id) => visited.has(id))
}

function inferredOutputPaths(node: WorkflowGraphNode): string[] {
  const base = `context.${node.id}.output`
  const paths = new Set<string>([base])
  for (const key of knownOutputFields[node.data.type] ?? []) paths.add(`${base}.${key}`)

  const mapping = node.data.config?.mapping
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const key of Object.keys(mapping).slice(0, 20)) {
      if (/^[A-Za-z0-9_$-]+$/.test(key)) paths.add(`${base}.${key}`)
    }
  }
  return [...paths]
}

export function buildExpressionSuggestions({
  nodes,
  edges,
  targetNodeId,
  mode,
  workflowInputs,
}: {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  targetNodeId: string
  mode: 'node' | 'edge'
  workflowInputs?: WorkflowInputSchemaShape
}): ExpressionSuggestion[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const upstreamIds = collectReachableUpstreamNodeIds({
    nodes,
    edges,
    targetNodeId,
    // An edge condition runs after its source step, so that source output is
    // available alongside all of its own ancestors.
    includeTarget: mode === 'edge',
  })

  const suggestions: ExpressionSuggestion[] = collectInputPaths(workflowInputs)
    .map(({ token, valueType }) => ({
      token,
      valueType,
      kind: 'input' as const,
    }))

  for (const nodeId of upstreamIds) {
    const node = byId.get(nodeId)
    if (!node) continue
    for (const token of inferredOutputPaths(node)) {
      suggestions.push({ token, kind: 'upstream', nodeId })
    }
  }

  return suggestions
}

/** Find syntactically-valid paths that are not available at this graph point. */
export function findUnresolvedExpressionReferences(
  expression: string,
  suggestions: ExpressionSuggestion[],
  mode: 'node' | 'edge',
): string[] {
  const withoutStrings = expression.replace(/'[^']*'|"[^"]*"/g, '')
  const references = withoutStrings.match(/\b(?:context|inputs)(?:\.[A-Za-z0-9_$-]+|\[\d+\])*/g) ?? []
  const inputPaths = suggestions.filter((item) => item.kind === 'input').map((item) => item.token)
  const inputShapeKnown = inputPaths.length > 0
  const upstreamBases = suggestions
    .filter((item) => item.kind === 'upstream' && item.token.endsWith('.output'))
    .map((item) => item.token)

  return [...new Set(references.filter((reference) => {
    if (reference === 'context') return false
    if (reference === 'inputs' || reference.startsWith('inputs.') || reference.startsWith('inputs[')) return mode === 'edge'
    if (reference === 'context.input') return false
    if (reference.startsWith('context.input.') || reference.startsWith('context.input[')) {
      return inputShapeKnown && !inputPaths.includes(reference)
    }
    return !upstreamBases.some((base) => reference === base || reference.startsWith(`${base}.`))
  }))]
}

export function inspectExpressionAuthoring(
  expression: string,
  suggestions: ExpressionSuggestion[],
  mode: 'node' | 'edge',
): ExpressionAuthoringState {
  if (!expression.trim()) return { status: 'empty' }
  const parserResult = validateExpression(expression)
  if (!parserResult.valid) {
    return { status: 'invalid', code: 'invalid_grammar' }
  }
  if (mode === 'edge' && /\binputs(?:\.|\[)/.test(expression.replace(/'[^']*'|"[^"]*"/g, ''))) {
    return { status: 'invalid', code: 'invalid_grammar' }
  }
  const unresolved = findUnresolvedExpressionReferences(expression, suggestions, mode)
  return unresolved.length > 0
    ? { status: 'invalid', code: 'unresolved', references: unresolved }
    : { status: 'valid' }
}
