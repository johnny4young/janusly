/**
 * React Flow canvas wrapper — the workflow editor's main surface. The
 * `workflowNodeTypes` map (from `./WorkflowStepNode`) plugs the custom
 * step renderer in. The 6 browser-mode tests in `WorkflowCanvas.browser.test.tsx`
 * lock its render contract; before changing the DOM structure
 * inspect those tests for selector breakage.
 *
 * Used by `App.tsx` (the workspace's main pane).
 */

import React from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react'
import type { EdgeMouseHandler, NodeMouseHandler, OnConnect, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { workflowNodeTypes } from './WorkflowStepNode'
import { workflowEdgeTypes } from './WorkflowEdge'
import { getNodeHelper, getNodeLabel } from '../constants'
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
}

/** Render the workflow editor canvas with React Flow + custom step nodes.
 *  Memoized so it only re-renders when its (stable) graph + handler props
 *  actually change, not on every unrelated store tick from the App root. */
export const WorkflowCanvas = React.memo(function WorkflowCanvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onEdgeClick, paletteNodeTypes, onAddNode }: WorkflowCanvasProps) {
  const { t } = useT()
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
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.45}
        maxZoom={1.35}
      >
        <Background color="var(--we-grid-strong)" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
        <Controls />
      </ReactFlow>
    </div>
  )
})
