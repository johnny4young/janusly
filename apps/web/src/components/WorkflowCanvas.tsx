import React from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react'
import type { EdgeMouseHandler, NodeMouseHandler, OnConnect, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { workflowNodeTypes } from './WorkflowStepNode'
import '@xyflow/react/dist/style.css'

type WorkflowCanvasProps = {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  onNodesChange: OnNodesChange<WorkflowGraphNode>
  onEdgesChange: OnEdgesChange<WorkflowGraphEdge>
  onConnect: OnConnect
  onNodeClick: NodeMouseHandler<WorkflowGraphNode>
  onEdgeClick: EdgeMouseHandler<WorkflowGraphEdge>
}

export function WorkflowCanvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onEdgeClick }: WorkflowCanvasProps) {
  return (
    <div className="canvas-frame">
      <div className="canvas-toolbar" aria-label="Flow map summary">
        <div>
          <div className="section-kicker">Flow map</div>
          <strong>{nodes.length} steps</strong>
        </div>
        <span>{edges.length} paths</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={workflowNodeTypes}
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
}
