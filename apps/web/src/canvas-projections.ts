/**
 * Pure projection helpers for the React Flow canvas. The App-level
 * memos call into these to build the `visibleNodes` / `visibleEdges`
 * arrays React Flow consumes. By design these functions:
 *
 * - Do NOT depend on the current UI locale (no `t`, no `i18n.language`
 *   in the function signature). Locale-dependent rendering (the node
 *   label/helper and the conditional-edge label) lives inside the
 *   leaf components `WorkflowStepNode` and `WorkflowEdge`, both of
 *   which subscribe via `useT()` and re-render on language change.
 * - Do NOT emit React-Flow style objects. Visual selection state is
 *   encoded via the `selected` field that the custom edge component
 *   projects onto a `data-selected` DOM attribute; the stroke + width
 *   changes live in `apps/web/src/styles/canvas.css` keyed on
 *   `.we-edge[data-selected="true"]`. The one marker object is a
 *   module-scoped constant so arrowheads stay visible without
 *   per-render allocation.
 *
 * Together those two choices preserve React Flow's identity-based memo
 * across `platformVersion` bumps and locale toggles, so the canvas
 * stops re-rendering N-per-tick.
 *
 * Used by `apps/web/src/App.tsx`.
 */

import type { EdgeMarker } from '@xyflow/react'
import type { JsonObject, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape, RunNode, RunSummary } from './types'

/**
 * Data envelope projected onto every edge passed to React Flow. The
 * `hasCondition` flag is the structural signal `WorkflowEdge` uses to
 * decide whether to render the locale-dependent condition label —
 * keeping the flag a boolean (not the resolved string) is what lets
 * the upstream memo skip re-projection on locale toggles.
 */
export type EdgeData = { condition?: string; hasCondition?: boolean }

/**
 * Stable arrow marker shared by every projected workflow edge. Keeping
 * this module-scoped preserves React Flow identity checks while retaining
 * the directed-edge cue from the previous canvas renderer.
 *
 * The marker type is the literal `'arrowclosed'` (the value of
 * `MarkerType.ArrowClosed`, accepted by `EdgeMarker`'s `` `${MarkerType}` ``
 * branch) rather than the enum, so this boot-reachable module pulls no
 * `@xyflow/react` runtime code — React Flow loads lazily with the canvas.
 */
export const WORKFLOW_EDGE_MARKER_END: EdgeMarker = {
  type: 'arrowclosed',
  color: 'var(--we-faint)',
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

const WORKFLOW_INPUT_TYPES = new Set<WorkflowInputSchemaShape['type']>(['string', 'number', 'boolean', 'object', 'array'])

/**
 * Validate the recursive workflow-input subset without pulling Zod into the
 * web boot chunk. The explicit work list avoids overflowing the JS stack when
 * localStorage or a historical payload contains maliciously deep JSON.
 */
function isWorkflowInputSchema(value: unknown): value is WorkflowInputSchemaShape {
  const pending: unknown[] = [value]
  let visited = 0

  while (pending.length > 0) {
    const schema = asObject(pending.pop())
    if (!schema || !WORKFLOW_INPUT_TYPES.has(schema.type as WorkflowInputSchemaShape['type'])) return false
    if (schema.description !== undefined && typeof schema.description !== 'string') return false
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(item => typeof item === 'string'))) return false
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false
    if (schema.items !== undefined) pending.push(schema.items)

    if (schema.properties !== undefined) {
      const properties = asObject(schema.properties)
      if (!properties) return false
      pending.push(...Object.values(properties))
    }

    // A valid authoring payload is tiny. Bound adversarial historical input so
    // validation remains fail-closed instead of monopolising the main thread.
    visited += 1
    if (visited > 10_000) return false
  }

  return true
}

/** Validate a persisted run workflow as a complete graph, never a partial one. */
export function getRunWorkflowSnapshot(inputJson: RunSummary['inputJson']): WorkflowDefinition | null {
  const workflow = asObject(asObject(inputJson)?.workflow)
  let positionKeys: string[] = []
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) return null
  if (workflow.id !== undefined && !isNonemptyString(workflow.id)) return null
  if (workflow.name !== undefined && !isNonemptyString(workflow.name)) return null
  if (workflow.inputs !== undefined && !isWorkflowInputSchema(workflow.inputs)) return null
  if (workflow.outputs !== undefined) {
    const outputs = asObject(workflow.outputs)
    if (!outputs || !Object.values(outputs).every(output => typeof output === 'string')) return null
  }
  if (workflow.templatePolicy !== undefined
    && workflow.templatePolicy !== 'lenient'
    && workflow.templatePolicy !== 'strict') return null
  if (workflow.ui !== undefined) {
    const ui = asObject(workflow.ui)
    if (!ui) return null
    if (ui.positions !== undefined) {
      const positions = asObject(ui.positions)
      if (!positions) return null
      positionKeys = Object.keys(positions)
      for (const positionValue of Object.values(positions)) {
        const position = asObject(positionValue)
        if (!position || typeof position.x !== 'number' || !Number.isFinite(position.x)
          || typeof position.y !== 'number' || !Number.isFinite(position.y)) return null
      }
    }
  }

  const nodeIds = new Set<string>()
  for (const rawNode of workflow.nodes) {
    const node = asObject(rawNode)
    if (!isNonemptyString(node?.id) || !isNonemptyString(node.type)) return null
    if (node.label !== undefined && (!isNonemptyString(node.label) || node.label.length > 80)) return null
    if (node.config !== undefined && !asObject(node.config)) return null
    if (nodeIds.has(node.id)) return null
    nodeIds.add(node.id)
  }
  if (positionKeys.some(nodeId => !nodeIds.has(nodeId))) return null

  for (const rawEdge of workflow.edges) {
    const edge = asObject(rawEdge)
    if (!isNonemptyString(edge?.from) || !isNonemptyString(edge.to)) return null
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return null
    if (edge.condition !== undefined && !isNonemptyString(edge.condition)) return null
  }

  return workflow as WorkflowDefinition
}

/**
 * Convert a persisted workflow snapshot into the editor-neutral React Flow
 * graph shape. New workflow JSON may persist visual positions; historical
 * snapshots fall back to the established deterministic authoring layout.
 * It is deliberately topology-agnostic: invalid cycles still render every
 * persisted step instead of silently omitting evidence from the run snapshot.
 */
export function workflowToGraph(workflow: WorkflowDefinition): {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
} {
  const nodes = workflow.nodes.map((node, index) => ({
      id: node.id,
      position: workflow.ui?.positions?.[node.id] ?? { x: 80 + index * 230, y: 80 + (index % 3) * 120 },
      // Empty labels keep resolving localized type copy at render time.
      data: { label: node.label ?? '', type: node.type, config: node.config ?? {} },
    }))

  const edges = workflow.edges.map((edge, index) => ({
    id: `e${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.condition ? 'condition' : undefined,
    animated: Boolean(edge.condition),
    data: { condition: edge.condition },
  }))

  return { nodes, edges }
}

/**
 * Project the raw workflow edges into the React-Flow shape. The
 * returned objects carry `type: 'workflowEdge'` so React Flow routes
 * them to the custom edge component (registered in
 * `WorkflowCanvas.tsx`). `selected` is set on the matching edge so
 * the component can flip `data-selected` for CSS-driven styling.
 * `markerEnd` is a stable module-scoped object so directed workflow
 * edges keep their arrowhead without allocating a new marker per render.
 *
 * Locale-independent: identical inputs produce identical outputs
 * regardless of UI language. Identity stable when `edges` +
 * `selectedEdgeId` are unchanged across calls — that's what React
 * Flow needs to skip downstream work.
 */
export function projectVisibleEdges(
  edges: WorkflowGraphEdge[],
  selectedEdgeId: string | null,
): WorkflowGraphEdge[] {
  return edges.map((edge) => {
    const hasCondition = Boolean(edge.data?.condition)
    return {
      ...edge,
      type: 'workflowEdge',
      animated: hasCondition,
      selected: selectedEdgeId === edge.id,
      markerEnd: WORKFLOW_EDGE_MARKER_END,
      data: { ...edge.data, hasCondition },
    }
  })
}

/** Run-status lookup keyed by node id, sourced from `runNodes`. */
export type NodeStatusMap = ReadonlyMap<string, RunNode['status']>
/** Validation issue shape — only the `nodeId` field matters here. */
export type ValidationIssue = { nodeId?: string }

/**
 * Project the raw workflow nodes into the React-Flow shape. Status,
 * validation flag, and selection state are folded into `data` so
 * `WorkflowStepNode` can read them. The function does NOT pre-resolve
 * `label` / `helper` — `WorkflowStepNode` falls back to
 * `getNodeLabel(type)` / `getNodeHelper(type)` at render time, which
 * re-resolve via the i18n module on each render the locale change
 * triggers (the component subscribes via `useT()`).
 */
export function projectVisibleNodes(
  nodes: WorkflowGraphNode[],
  statusMap: NodeStatusMap,
  validationIssues: readonly ValidationIssue[],
  selectedNodeId: string | null,
): WorkflowGraphNode[] {
  return nodes.map((node) => {
    const status = statusMap.get(node.id) ?? 'pending'
    const hasValidationError = validationIssues.some((issue) => issue.nodeId === node.id)
    const isSelected = selectedNodeId === node.id
    return {
      ...node,
      type: 'workflowStep',
      data: { ...node.data, status, hasValidationError },
      selected: isSelected,
    }
  })
}
