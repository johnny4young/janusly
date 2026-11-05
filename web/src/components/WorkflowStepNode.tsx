/**
 * Custom React Flow node renderer for Janusly steps. Per-type icon, label,
 * config summary, and status pill. The `workflowNodeTypes` export plugs
 * this renderer into the canvas via React Flow's `nodeTypes` prop.
 *
 * Used by `WorkflowCanvas.tsx`.
 */

import React from 'react'
import { Activity, Boxes, Bot, CheckCircle2, ClipboardList, FileInput, GitBranch, Layers3, Mail, Radio, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { formatStatusLabel, getNodeConfigSummary, getNodeHelper, getNodeLabel } from '../constants'
import { useT } from '../i18n'
import { localizeAuthoringProblem } from './authoring-problems'
import { openAuthoringProblem } from './open-authoring-problem'
import { Button } from './ui/Button'
import type { WorkflowGraphNode } from '../types'

const nodeIcons: Record<string, React.ReactNode> = {
  http: <Activity size={15} />,
  noop: <SquarePlus size={15} />,
  transform: <GitBranch size={15} />,
  loop: <Workflow size={15} />,
  condition: <CheckCircle2 size={15} />,
  webhook: <Activity size={15} />,
  approval: <Users size={15} />,
  human_form: <ClipboardList size={15} />,
  ai: <Sparkles size={15} />,
  tool: <Boxes size={15} />,
  agent: <Bot size={15} />,
  agent_reflection: <Activity size={15} />,
  multi_agent: <Layers3 size={15} />,
  router: <GitBranch size={15} />,
  router_llm: <Sparkles size={15} />,
  webhook_received: <Activity size={15} />,
  email_received: <Mail size={15} />,
  file_dropped: <FileInput size={15} />,
  mcp_server_event: <Radio size={15} />,
}

/** Render one workflow step on the canvas with icon, label, summary, and status pill. */
export function WorkflowStepNode({ data, selected }: NodeProps<WorkflowGraphNode>) {
  // Subscribe to locale changes so `getNodeLabel` / `getNodeHelper` /
  // `getNodeConfigSummary` re-resolve through the catalog runtime
  // after a language toggle. The upstream `visibleNodes` memo
  // intentionally does NOT carry `i18n.language` in its dep array —
  // making the leaf component the locale reactivity boundary keeps
  // the canvas projection identity stable across toggles.
  const { t } = useT()
  const status = data.status ?? 'pending'
  const type = data.type
  const title = data.label?.trim() || getNodeLabel(type)
  const helper = data.helper || getNodeHelper(type)
  const summary = getNodeConfigSummary(type, data.config ?? {})
  const tone = data.hasValidationError ? 'error' : status
  const problem = data.problem

  return (
    <div className="workflow-node" data-status={tone} data-selected={selected ? 'true' : 'false'}>
      <Handle className="workflow-handle workflow-handle-target" type="target" position={Position.Top} />
      {problem && (
        <Button
          variant="ghost"
          className="workflow-node-problem nodrag nopan nokey"
          data-severity={problem.severity}
          data-testid="workflow-node-problem"
          title={localizeAuthoringProblem(problem)}
          aria-label={t('problems.openNode', { id: title })}
          onClick={(event) => {
            event.stopPropagation()
            openAuthoringProblem(problem)
          }}
        />
      )}
      <div className="workflow-node-head">
        <span className="workflow-node-icon">{nodeIcons[type] ?? <SquarePlus size={15} />}</span>
        <span className="workflow-node-title">{title}</span>
        <span className="status-pill workflow-node-status" data-status={tone}>{formatStatusLabel(status)}</span>
      </div>
      <p>{helper}</p>
      {data.errorSummary
        ? <div className="workflow-node-summary workflow-node-error" data-testid="workflow-node-error">{data.errorSummary}</div>
        : <div className="workflow-node-summary">{summary}</div>}
      {data.onRecover && (
        <Button
          size="sm"
          className="workflow-node-recover nodrag nopan"
          onClick={(event) => {
            event.stopPropagation()
            data.onRecover?.()
          }}
          data-testid="workflow-node-recover"
        >
          {t('canvas.recoverStep')}
        </Button>
      )}
      <Handle className="workflow-handle workflow-handle-source" type="source" position={Position.Bottom} />
    </div>
  )
}

/** Map of React Flow `nodeTypes` — one entry, registered as `default`. */
export const workflowNodeTypes = {
  workflowStep: WorkflowStepNode,
}
