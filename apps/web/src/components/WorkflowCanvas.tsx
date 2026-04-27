import React from 'react'
import { Activity, Boxes, Bot, CheckCircle2, GitBranch, Layers3, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow } from '@xyflow/react'
import type { EdgeMouseHandler, NodeMouseHandler, NodeProps, OnConnect, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import { formatStatusLabel, getNodeConfigSummary, getNodeHelper, getNodeLabel } from '../constants'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
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

const nodeIcons: Record<string, React.ReactNode> = {
  http: <Activity size={15} />,
  noop: <SquarePlus size={15} />,
  transform: <GitBranch size={15} />,
  loop: <Workflow size={15} />,
  condition: <CheckCircle2 size={15} />,
  webhook: <Activity size={15} />,
  approval: <Users size={15} />,
  ai: <Sparkles size={15} />,
  tool: <Boxes size={15} />,
  agent: <Bot size={15} />,
  agent_reflection: <Activity size={15} />,
  multi_agent: <Layers3 size={15} />,
  router: <GitBranch size={15} />,
  router_llm: <Sparkles size={15} />,
}

const workflowNodeTypes = {
  workflowStep: WorkflowStepNode,
}

function WorkflowStepNode({ data, selected }: NodeProps<WorkflowGraphNode>) {
  const status = data.status ?? 'pending'
  const type = data.type
  const title = data.label || getNodeLabel(type)
  const helper = data.helper || getNodeHelper(type)
  const summary = getNodeConfigSummary(type, data.config ?? {})
  const tone = data.hasValidationError ? 'error' : status

  return (
    <div className="workflow-node" data-status={tone} data-selected={selected ? 'true' : 'false'}>
      <Handle className="workflow-handle workflow-handle-target" type="target" position={Position.Top} />
      <div className="workflow-node-head">
        <span className="workflow-node-icon">{nodeIcons[type] ?? <SquarePlus size={15} />}</span>
        <span className="workflow-node-title">{title}</span>
        <span className="status-pill workflow-node-status" data-status={tone}>{formatStatusLabel(status)}</span>
      </div>
      <p>{helper}</p>
      <div className="workflow-node-summary">{summary}</div>
      <Handle className="workflow-handle workflow-handle-source" type="source" position={Position.Bottom} />
    </div>
  )
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
