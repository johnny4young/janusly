/**
 * Right-side Inspector tab body. Renders one of three views:
 *  1. A per-node card when a workflow node is selected (config editor +
 *     advanced JSON + validation issues + AI usage footer).
 *  2. A per-edge card when an edge is selected (condition editor).
 *  3. An empty-state with the workflow's declared I/O schema card.
 *
 * Used by:
 * - `RightPanel.tsx` (mounted in the inspector branch of the dispatcher).
 */

import React, { useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, RunNode, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { formatStatusLabel, getNodeConfigSummary, getNodeLabel, nodeTypes } from '../constants'
import { useT } from '../i18n'
import { AiUsageFooter } from './AiUsageFooter'
import { QuickConfigEditor } from './QuickConfigEditor'

type InspectorPanelProps = {
  selectedNode: WorkflowGraphNode | null
  selectedEdge: WorkflowGraphEdge | null
  runNodes: RunNode[]
  validationIssues: ValidationIssue[]
  tools: ToolSchema[]
  currentWorkflowInputs?: WorkflowDefinition['inputs']
  currentWorkflowOutputs?: WorkflowDefinition['outputs']
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
}

export function InspectorPanel({
  selectedNode,
  selectedEdge,
  runNodes,
  validationIssues,
  tools,
  currentWorkflowInputs,
  currentWorkflowOutputs,
  onUpdateNodeConfig,
  onUpdateNodeType,
  onUpdateEdgeCondition,
}: InspectorPanelProps) {
  const { t } = useT()
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nodeStatus = selectedNode ? runNodes.find(node => node.nodeId === selectedNode.id) : null
  const nodeIssues = selectedNode ? validationIssues.filter(issue => issue.nodeId === selectedNode.id) : []

  if (selectedNode) {
    const status = nodeStatus?.status ?? 'draft'

    return (
      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('rightPanel.inspector.stepKicker')}</div>
            <h3>{getNodeLabel(selectedNode.data.type)}</h3>
            <p className="helper-text">{getNodeConfigSummary(selectedNode.data.type, selectedNode.data.config ?? {})}</p>
          </div>
          <div className="inspector-header-pills">
            <span className="status-pill" data-status={status}>{formatStatusLabel(status)}</span>
            <span
              className={`we-pill ${nodeIssues.length ? 'we-pill--red' : 'we-pill--green'}`}
              data-testid="inspector-validation-pill"
            >
              {nodeIssues.length ? t('rightPanel.inspector.issueCount', { count: nodeIssues.length }) : t('rightPanel.inspector.ready')}
            </span>
          </div>
        </div>

        <div className="inspector-meta">
          <span>{t('rightPanel.inspector.stepIdLabel', { id: selectedNode.id })}</span>
        </div>

        <AiUsageFooter stateJson={nodeStatus?.stateJson} />


        <div className="form-grid">
          <label className="field-label" htmlFor="node-type">{t('rightPanel.inspector.stepKindLabel')}</label>
          <select id="node-type" className="text-field" value={selectedNode.data.type} onChange={event => onUpdateNodeType(event.target.value)}>
            {nodeTypes.map(type => <option key={type} value={type}>{getNodeLabel(type)}</option>)}
          </select>
        </div>

        <QuickConfigEditor
          key={selectedNode.id}
          nodeId={selectedNode.id}
          type={selectedNode.data.type}
          config={selectedNode.data.config ?? {}}
          tools={tools}
          onUpdate={onUpdateNodeConfig}
        />

        <details className="advanced-config">
          <summary>{t('rightPanel.inspector.advancedJsonSummary')}</summary>
          <p className="helper-text">{t('rightPanel.inspector.advancedJsonHelper')}</p>
          <textarea
            key={`${selectedNode.id}-json`}
            id="node-config"
            className="code-field"
            defaultValue={JSON.stringify(selectedNode.data.config, null, 2)}
            onBlur={(event) => {
              try {
                const parsed = JSON.parse(event.target.value) as Record<string, unknown>
                onUpdateNodeConfig(parsed)
                setJsonError(null)
              } catch (error) {
                setJsonError(error instanceof Error ? error.message : (t('rightPanel.inspector.invalidJson') as string))
              }
            }}
          />
        </details>

        {jsonError && <div className="issue issue-error">{jsonError}</div>}
        {nodeIssues.map(issue => <div key={`${issue.code}-${issue.message}`} className="issue issue-error">{issue.message}</div>)}
      </section>
    )
  }

  if (selectedEdge) {
    return (
      <section className="panel-card">
        <div className="section-kicker">{t('rightPanel.inspector.pathKicker')}</div>
        <h3>{t('rightPanel.inspector.pathTitle', { source: selectedEdge.source, target: selectedEdge.target })}</h3>
        <label className="field-label" htmlFor="edge-condition">{t('rightPanel.inspector.runOnlyWhen')}</label>
        <textarea
          id="edge-condition"
          className="code-field code-field-short"
          defaultValue={selectedEdge.data?.condition ?? ''}
          onBlur={(event) => onUpdateEdgeCondition(selectedEdge.id, event.target.value.trim())}
          placeholder={t('rightPanel.inspector.conditionPlaceholder') as string}
        />
      </section>
    )
  }

  const hasIoSchema = Boolean(currentWorkflowInputs || (currentWorkflowOutputs && Object.keys(currentWorkflowOutputs).length > 0))

  return (
    <>
      {hasIoSchema && <WorkflowIoCard inputs={currentWorkflowInputs} outputs={currentWorkflowOutputs} />}
      <section className="panel-card">
        <div className="empty-panel">
          <GitBranch size={24} aria-hidden="true" />
          <strong>{t('rightPanel.inspector.emptyTitle')}</strong>
          <p>{t('rightPanel.inspector.emptyBody')}</p>
        </div>
      </section>
    </>
  )
}

/**
 * Render the workflow's declared I/O contract when no node/edge is selected.
 * Reads the JSON-Schema-subset `inputs` shape and the `outputs` projection
 * map. Empty when the workflow declares neither.
 */
function WorkflowIoCard({
  inputs,
  outputs,
}: {
  inputs?: WorkflowDefinition['inputs']
  outputs?: WorkflowDefinition['outputs']
}) {
  const { t } = useT()
  return (
    <section className="panel-card" data-testid="workflow-io-card">
      <div className="section-kicker">{t('rightPanel.inspector.ioKicker')}</div>
      <h3>{t('rightPanel.inspector.ioTitle')}</h3>
      <p className="helper-text">{t('rightPanel.inspector.ioHelper')}</p>

      {inputs && (
        <div className="form-grid">
          <div className="field-label">{t('rightPanel.inspector.inputsLabel')}</div>
          <ul className="inspector-meta" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {renderInputFields(inputs).map((row, idx) => (
              <li key={`${row.path}-${idx}`}>
                <span>{row.path}</span>
                <span>{row.type}{row.required ? t('rightPanel.inspector.requiredSuffix') : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outputs && Object.keys(outputs).length > 0 && (
        <div className="form-grid">
          <div className="field-label">{t('rightPanel.inspector.outputsLabel')}</div>
          <ul className="inspector-meta" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(outputs).map(([key, template]) => (
              <li key={key}>
                <span>{key}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{template}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Flatten a nested input schema into a list of `{ path, type, required }` rows for the Inspector. */
function renderInputFields(
  schema: NonNullable<WorkflowDefinition['inputs']>,
  basePath = '',
): Array<{ path: string; type: string; required: boolean }> {
  if (schema.type === 'object' && schema.properties) {
    const requiredSet = new Set(schema.required ?? [])
    return Object.entries(schema.properties).flatMap(([key, child]) => {
      const path = basePath ? `${basePath}.${key}` : key
      const isRequired = requiredSet.has(key)
      if (child.type === 'object' && child.properties) {
        return [{ path, type: child.type, required: isRequired }, ...renderInputFields(child, path)]
      }
      return [{ path, type: child.type, required: isRequired }]
    })
  }
  return [{ path: basePath || '$', type: schema.type, required: false }]
}
