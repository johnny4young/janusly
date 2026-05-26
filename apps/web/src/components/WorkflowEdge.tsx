/**
 * Custom React Flow edge renderer for Janusly workflows. Resolves the
 * conditional-edge label INSIDE the component via `useT()` so locale
 * toggles invalidate only the visible edge components, never the
 * upstream `visibleEdges` memo. Visual selection state rides on the
 * `data-selected` DOM attribute — the `.we-edge` rule in
 * `apps/web/src/index.css` switches stroke + width when it's `"true"`.
 *
 * Plugged into the canvas via `workflowEdgeTypes` in `WorkflowCanvas.tsx`.
 */

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useT } from '../i18n'
import type { EdgeData } from '../canvas-projections'

/** Render one workflow edge with the cobalt selection state encoded via CSS. */
export function WorkflowEdge(props: EdgeProps<EdgeData>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, markerEnd } = props
  const { t } = useT()
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const hasCondition = Boolean(data?.hasCondition)
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className="we-edge"
        data-selected={selected ? 'true' : 'false'}
        markerEnd={markerEnd}
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
