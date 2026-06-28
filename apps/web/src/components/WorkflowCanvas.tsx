/**
 * React Flow canvas wrapper — the workflow editor's main surface. The
 * `workflowNodeTypes` map (from `./WorkflowStepNode`) plugs the custom
 * step renderer in. The browser-mode tests in `WorkflowCanvas.browser.test.tsx`
 * lock its render contract; before changing the DOM structure
 * inspect those tests for selector breakage.
 *
 * Used by `App.tsx` (the workspace's main pane).
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react'
import type { EdgeMouseHandler, NodeMouseHandler, OnConnect, OnEdgesChange, OnMove, OnMoveEnd, OnNodesChange, Viewport } from '@xyflow/react'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { workflowNodeTypes } from './WorkflowStepNode'
import { workflowEdgeTypes } from './WorkflowEdge'
import { CanvasErrorBoundary } from './CanvasErrorBoundary'
import { getNodeHelper, getNodeLabel } from '../constants'
import { readCanvasViewport, writeCanvasViewport } from '../canvas-viewport'
import { useT } from '../i18n'
import '@xyflow/react/dist/style.css'

type WorkflowCanvasProps = {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  onNodesChange: OnNodesChange<WorkflowGraphNode>
  onEdgesChange: OnEdgesChange<WorkflowGraphEdge>
  onConnect: OnConnect
  onNodeClick: NodeMouseHandler<WorkflowGraphNode>
  onEdgeClick: EdgeMouseHandler<WorkflowGraphEdge>
  /** When present (AI Studio), renders a draggable-step palette over the
   *  canvas. Omitted elsewhere — the palette renders null, so the locked
   *  browser tests (which pass neither prop) are unaffected. */
  paletteNodeTypes?: string[]
  onAddNode?: (type: string) => void
  /** When present, the canvas restores this workflow's last saved viewport
   *  (zoom + pan) on mount instead of fitting-to-view, and persists user
   *  pan/zoom under it. Omitted (e.g. unsaved drafts, the locked browser
   *  tests) → always fit-to-view, no persistence. */
  viewportWorkflowId?: string
}

/** Render the workflow editor canvas with React Flow + custom step nodes.
 *  Memoized so it only re-renders when its (stable) graph + handler props
 *  actually change, not on every unrelated store tick from the App root. */
export const WorkflowCanvas = React.memo(function WorkflowCanvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onEdgeClick, paletteNodeTypes, onAddNode, viewportWorkflowId }: WorkflowCanvasProps) {
  const { t } = useT()
  // Restore the saved viewport on mount (read once per workflow key); when none
  // exists we fall back to `fitView`. React Flow ignores `defaultViewport` while
  // `fitView` is set, so the two are mutually exclusive below.
  const restoredViewport = useMemo(
    () => (viewportWorkflowId ? readCanvasViewport(viewportWorkflowId) : null),
    [viewportWorkflowId],
  )
  const latestViewportRef = useRef<Viewport | null>(restoredViewport)
  useEffect(() => {
    latestViewportRef.current = restoredViewport
  }, [restoredViewport, viewportWorkflowId])
  const handleMove = useCallback<OnMove>((_, viewport) => {
    latestViewportRef.current = viewport
  }, [])
  // Persist only deliberate operator pan/zoom — the automatic fitView / restore
  // fires `onMoveEnd` with a null event, which we skip so the stored viewport
  // always reflects a user gesture.
  const handleMoveEnd = useCallback<OnMoveEnd>(
    (event, viewport) => {
      latestViewportRef.current = viewport
      if (viewportWorkflowId && event !== null) writeCanvasViewport(viewportWorkflowId, viewport)
    },
    [viewportWorkflowId],
  )
  // React Flow's built-in Controls trigger viewport changes with a null source
  // event too, so the onMoveEnd guard above intentionally skips them along with
  // automatic fit/restore. Persist those explicit toolbar clicks via their
  // callbacks after React Flow has applied the new viewport.
  const persistCurrentViewport = useCallback(() => {
    if (!viewportWorkflowId || typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      const viewport = latestViewportRef.current
      if (viewport) writeCanvasViewport(viewportWorkflowId, viewport)
    })
  }, [viewportWorkflowId])
  const canvasErrorFallback = (
    <div className="canvas-error" role="alert">
      <strong>{t('canvas.error.title')}</strong>
      <p>{t('canvas.error.body')}</p>
      <button type="button" className="command-button" onClick={() => window.location.reload()}>
        {t('canvas.error.reload')}
      </button>
    </div>
  )

  return (
    <div className="canvas-frame">
      <div className="canvas-toolbar" aria-label={t('canvas.flowMapSummary')}>
        <div>
          <div className="section-kicker">{t('canvas.flowMap')}</div>
          <strong>{t('canvas.steps', { count: nodes.length })}</strong>
        </div>
        <span>{t('canvas.paths', { count: edges.length })}</span>
      </div>
      {paletteNodeTypes && onAddNode && paletteNodeTypes.length > 0 && (
        <div className="canvas-palette" role="toolbar" aria-label={t('canvas.palette') as string}>
          {paletteNodeTypes.map((type) => (
            <button
              key={type}
              type="button"
              className="sb-chip"
              onClick={() => onAddNode(type)}
              title={`${getNodeLabel(type)} — ${getNodeHelper(type)}`}
            >
              <span className="sb-chip__label">{getNodeLabel(type)}</span>
            </button>
          ))}
        </div>
      )}
      <CanvasErrorBoundary fallback={canvasErrorFallback}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={workflowNodeTypes}
        edgeTypes={workflowEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        fitView={!restoredViewport}
        fitViewOptions={{ padding: 0.22 }}
        defaultViewport={restoredViewport ?? undefined}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        minZoom={0.45}
        maxZoom={1.35}
      >
        <Background color="var(--we-grid-strong)" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
        <Controls onZoomIn={persistCurrentViewport} onZoomOut={persistCurrentViewport} onFitView={persistCurrentViewport} />
      </ReactFlow>
      </CanvasErrorBoundary>
      {nodes.length === 0 && (
        // Teaching overlay for a blank canvas — pointer-events stay off the
        // backdrop so the palette/canvas underneath remain interactive.
        <div className="canvas-empty" data-testid="canvas-empty">
          <div className="canvas-empty__card">
            <strong>{t('canvas.empty.title')}</strong>
            <p>{t('canvas.empty.body')}</p>
          </div>
        </div>
      )}
    </div>
  )
})
