/**
 * Custom React Flow edge renderer for Janusly workflows. Resolves the
 * conditional-edge label INSIDE the component via `useT()` so locale
 * toggles invalidate only the visible edge components, never the
 * upstream `visibleEdges` memo. Visual selection state rides on the
 * `data-selected` DOM attribute — the `.we-edge` rule in
 * `web/src/styles/canvas.css` switches stroke + width when it's `"true"`.
 *
 * Plugged into the canvas via `workflowEdgeTypes` in `WorkflowCanvas.tsx`.
 */

import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps, type Node } from '@xyflow/react'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'
import { scrubOperatorGuidanceSecrets } from '../lib/operator-guidance'
import type { WorkflowGraphEdge } from '../types'

/** Human label for an edge endpoint: the node's step label, falling back to its
 *  id. Keeps the directed connection legible to screen readers, which don't
 *  perceive the arrow marker. */
function endpointLabel(node: Node | undefined, fallbackId: string): string {
  const type = (node?.data as { type?: unknown } | undefined)?.type
  return typeof type === 'string' ? getNodeLabel(type) : fallbackId
}

/** Conditions are persisted operator input. Keep their useful expression in the
 * canvas and accessible name, but never render control characters or known
 * credential shapes. CSS owns visual truncation so the safe full value remains
 * available to assistive technology and the native title tooltip. */
function safeConditionLabel(condition: string | undefined): string {
  return scrubOperatorGuidanceSecrets(condition ?? '')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim()
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
  const hasOnError = Boolean(data?.hasOnError)
  const condition = safeConditionLabel(data?.condition)
  const kind = hasOnError ? 'error' : hasCondition && condition ? 'condition' : 'default'
  const routeLabel = kind === 'error'
    ? t('canvas.edge.onError')
    : kind === 'condition'
      ? t('canvas.edge.conditionValue', { condition })
      : t('canvas.edge.default')
  // Directed "from → to" label so the connection is reachable without seeing the
  // arrow (screen readers, dense graphs). Endpoint labels resolve at render time
  // via getNodeLabel so a locale toggle re-renders the edge, not the projection.
  const connectionLabel = t('canvas.edge.connectionRoute', {
    from: endpointLabel(getNode(source), source),
    to: endpointLabel(getNode(target), target),
    route: routeLabel,
  })
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className="we-edge"
        data-selected={selected ? 'true' : 'false'}
        data-on-error={hasOnError ? 'true' : 'false'}
        markerEnd={markerEnd}
        aria-label={connectionLabel}
        role="img"
      />
      <EdgeLabelRenderer>
        <div
          className="we-edge-label"
          data-kind={kind}
          data-selected={selected ? 'true' : 'false'}
          title={routeLabel}
          aria-hidden="true"
          style={{
            // The transform-only inline style is React Flow's standard
            // pattern for label positioning (foreign-object portals);
            // it carries no theme tokens.
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {routeLabel}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

/** React Flow `edgeTypes` map — module-scoped so React Flow gets a stable reference. */
export const workflowEdgeTypes = {
  workflowEdge: WorkflowEdge,
}
