/**
 * Custom React Flow edge renderer for Janusly workflows. Resolves the
 * conditional-edge label INSIDE the component via `useT()` so locale
 * toggles invalidate only the visible edge components, never the
 * upstream `visibleEdges` memo. Visual selection state rides on the
 * `data-selected` DOM attribute — the `.we-edge` rule in
 * `apps/web/src/styles/workflow.css` switches stroke + width when it's `"true"`.
 *
 * Plugged into the canvas via `workflowEdgeTypes` in `WorkflowCanvas.tsx`.
 */

import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps, type Node } from '@xyflow/react'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'
import type { WorkflowGraphEdge } from '../types'

/** Human label for an edge endpoint: the node's step label, falling back to its
 *  id. Keeps the directed connection legible to screen readers, which don't
 *  perceive the arrow marker. */
function endpointLabel(node: Node | undefined, fallbackId: string): string {
  const type = (node?.data as { type?: unknown } | undefined)?.type
  return typeof type === 'string' ? getNodeLabel(type) : fallbackId
}

/** Render one workflow edge with the cobalt selection state encoded via CSS. */
export function WorkflowEdge(props: EdgeProps<WorkflowGraphEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, markerEnd } = props
  const { t } = useT()
  const { getNode } = useReactFlow()
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const hasCondition = Boolean(data?.hasCondition)
  // Directed "from → to" label so the connection is reachable without seeing the
  // arrow (screen readers, dense graphs). Endpoint labels resolve at render time
  // via getNodeLabel so a locale toggle re-renders the edge, not the projection.
  const connectionLabel = t('canvas.edge.connection', {
    from: endpointLabel(getNode(source), source),
    to: endpointLabel(getNode(target), target),
  })
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className="we-edge"
        data-selected={selected ? 'true' : 'false'}
        markerEnd={markerEnd}
        aria-label={connectionLabel}
        role="img"
      />
      {hasCondition ? (
        <EdgeLabelRenderer>
          <div
            className="we-edge-label"
            data-selected={selected ? 'true' : 'false'}
            style={{
              // The transform-only inline style is React Flow's standard
              // pattern for label positioning (foreign-object portals);
              // it carries no theme tokens.
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {t('canvas.edge.condition')}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

/** React Flow `edgeTypes` map — module-scoped so React Flow gets a stable reference. */
export const workflowEdgeTypes = {
  workflowEdge: WorkflowEdge,
}
