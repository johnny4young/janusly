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
 *   changes live in `apps/web/src/index.css` keyed on
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

import { MarkerType, type EdgeMarker } from '@xyflow/react'
import type { WorkflowGraphEdge, WorkflowGraphNode, RunNode } from './types'

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
 */
export const WORKFLOW_EDGE_MARKER_END: EdgeMarker = {
  type: MarkerType.ArrowClosed,
  color: 'var(--we-faint)',
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
