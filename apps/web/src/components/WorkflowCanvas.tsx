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
import type { AriaLabelConfig, EdgeMouseHandler, NodeMouseHandler, OnBeforeDelete, OnConnect, OnEdgesChange, OnMove, OnMoveEnd, OnNodesChange, Viewport } from '@xyflow/react'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { workflowNodeTypes } from './WorkflowStepNode'
import { workflowEdgeTypes } from './WorkflowEdge'
import { CanvasErrorBoundary } from './CanvasErrorBoundary'
import { useConfirm } from './ConfirmDialog'
import { formatStatusLabel, getNodeHelper, getNodeLabel } from '../constants'
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
  /** `observe` renders an immutable run snapshot: operators can pan/zoom and
   *  focus nodes, but cannot drag, connect, reconnect, or delete anything. */
  mode?: 'author' | 'observe'
  /** Keep the mounted editor inert while its tab is hidden. This preserves
   *  viewport/selection without letting its document-level keyboard handlers
   *  react to an interaction in a different workspace. */
  active?: boolean
}

/** Render the workflow editor canvas with React Flow + custom step nodes.
 *  Memoized so it only re-renders when its (stable) graph + handler props
 *  actually change, not on every unrelated store tick from the App root. */
export const WorkflowCanvas = React.memo(function WorkflowCanvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onEdgeClick, paletteNodeTypes, onAddNode, viewportWorkflowId, mode = 'author', active = true }: WorkflowCanvasProps) {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const observing = mode === 'observe'
  const editing = active && !observing
  // Give every node a meaningful screen-reader name. React Flow's default node
  // aria-label is just "Node <id>"; announce the step's localized label instead
  // ("Step: Call an API"). Derived here, not in the store, so it stays localized
  // and never pollutes the persisted / serialized graph. React Flow reads
  // `node.ariaLabel` (NodeBase) for the focusable node wrapper.
  const a11yNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        ariaLabel: t(observing ? 'canvas.runNodeAria' : 'canvas.nodeAria', {
          label: node.data.label?.trim() || getNodeLabel(node.data.type),
          status: formatStatusLabel(node.data.status ?? 'pending'),
        }) as string,
      })),
    [nodes, observing, t],
  )
  const a11yEdges = useMemo(() => {
    const nodeLabels = new Map(nodes.map(node => [
      node.id,
      node.data.label?.trim() || getNodeLabel(node.data.type),
    ]))
    return edges.map(edge => ({
      ...edge,
      ariaLabel: t('canvas.edgeAria', {
        source: nodeLabels.get(edge.source) ?? edge.source,
        target: nodeLabels.get(edge.target) ?? edge.target,
      }) as string,
    }))
  }, [edges, nodes, t])
  const ariaLabelConfig = useMemo<Partial<AriaLabelConfig>>(() => {
    if (!observing) return {}
    const readOnlyInstructions = t('canvas.readOnly') as string
    return {
      'node.a11yDescription.default': readOnlyInstructions,
      'node.a11yDescription.keyboardDisabled': readOnlyInstructions,
      'edge.a11yDescription.default': readOnlyInstructions,
      'controls.ariaLabel': t('canvas.runMap') as string,
      'controls.zoomIn.ariaLabel': t('canvas.a11y.zoomIn') as string,
      'controls.zoomOut.ariaLabel': t('canvas.a11y.zoomOut') as string,
      'controls.fitView.ariaLabel': t('canvas.a11y.fitView') as string,
    }
  }, [observing, t])
  // Confirm before a node is removed (Delete/Backspace or the toolbar) — a
  // mis-keyed delete can otherwise drop a configured step silently. Edge-only
  // deletions skip the prompt: re-drawing a connection is cheap and reversible.
  const onBeforeDelete = useCallback<OnBeforeDelete<WorkflowGraphNode, WorkflowGraphEdge>>(
    async ({ nodes: nodesToDelete }) => {
      if (!editing) return false
      if (nodesToDelete.length === 0) return true
      return confirmDialog({
        body: t('canvas.deleteConfirm', { count: nodesToDelete.length }) as string,
        tone: 'danger',
      })
    },
    [confirmDialog, editing, t],
  )
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
    <div className="canvas-frame" data-mode={mode} data-testid={observing ? 'run-observation-canvas' : undefined}>
      <div className="canvas-toolbar" aria-label={t(observing ? 'canvas.runMap' : 'canvas.flowMapSummary')}>
        <div>
          <div className="section-kicker">{t(observing ? 'canvas.runMap' : 'canvas.flowMap')}</div>
          <strong>{t('canvas.steps', { count: nodes.length })}</strong>
        </div>
        <div className="canvas-toolbar__meta">
          <span>{t('canvas.paths', { count: edges.length })}</span>
          {observing && <span className="we-pill we-pill--info">{t('canvas.readOnly')}</span>}
        </div>
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
      <CanvasErrorBoundary fallback={canvasErrorFallback} resetKey={viewportWorkflowId}>
      <ReactFlow
        nodes={a11yNodes}
        edges={a11yEdges}
        nodeTypes={workflowNodeTypes}
        edgeTypes={workflowEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onBeforeDelete={onBeforeDelete}
        fitView={!restoredViewport}
        fitViewOptions={{ padding: 0.22 }}
        defaultViewport={restoredViewport ?? undefined}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        minZoom={0.45}
        maxZoom={1.35}
        nodesDraggable={editing}
        nodesConnectable={editing}
        edgesReconnectable={editing}
        deleteKeyCode={editing ? ['Backspace', 'Delete'] : null}
        disableKeyboardA11y={!editing}
        ariaLabelConfig={ariaLabelConfig}
      >
        <Background color="var(--we-grid-strong)" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
        <Controls
          showInteractive={!observing}
          onZoomIn={persistCurrentViewport}
          onZoomOut={persistCurrentViewport}
          onFitView={persistCurrentViewport}
        />
      </ReactFlow>
      </CanvasErrorBoundary>
      {nodes.length === 0 && (
        // Teaching overlay for a blank canvas — pointer-events stay off the
        // backdrop so the palette/canvas underneath remain interactive.
        <div className="canvas-empty" data-testid="canvas-empty">
          <div className="canvas-empty__card">
            <strong>{t(observing ? 'canvas.runEmpty.title' : 'canvas.empty.title')}</strong>
            <p>{t(observing ? 'canvas.runEmpty.body' : 'canvas.empty.body')}</p>
          </div>
        </div>
      )}
    </div>
  )
})
