import React from 'react'
import { Activity, Boxes, Bot, CheckCircle2, GitBranch, Layers3, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { formatStatusLabel, getNodeConfigSummary, getNodeHelper, getNodeLabel } from '../constants'
import type { WorkflowGraphNode } from '../types'

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

export function WorkflowStepNode({ data, selected }: NodeProps<WorkflowGraphNode>) {
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

export const workflowNodeTypes = {
  workflowStep: WorkflowStepNode,
}
