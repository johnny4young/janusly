import React from 'react'
import { ReactFlow, Background, Controls } from '@xyflow/react'

export function WorkflowCanvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onEdgeClick }: any) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
    >
      <Background />
      <Controls />
    </ReactFlow>
  )
}
