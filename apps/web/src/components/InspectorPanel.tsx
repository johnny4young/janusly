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

import React, { useEffect, useRef, useState } from 'react'
import { Copy, GitBranch, Layers } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, RunNode, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { formatNodeDuration, formatStatusLabel, getNodeConfigSummary, getNodeLabel, nodeTypes } from '../constants'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { AiUsageFooter } from './AiUsageFooter'
import { pickErrorMessage } from './recovery-dialog/helpers'
import { QuickConfigEditor } from './QuickConfigEditor'
import { ExpressionAssistant } from './ExpressionAssistant'
import {
  AUTHORING_FOCUS_EVENT,
  consumeAuthoringFocus,
  parseAuthoringFocusEvent,
  type AuthoringFocusRequest,
} from './authoring-focus-bus'

type InspectorPanelProps = {
  selectedNode: WorkflowGraphNode | null
  selectedEdge: WorkflowGraphEdge | null
  runNodes: RunNode[]
  validationIssues: ValidationIssue[]
  tools: ToolSchema[]
  workflowNodes: WorkflowGraphNode[]
  workflowEdges: WorkflowGraphEdge[]
  currentWorkflowName?: string
  currentWorkflowInputs?: WorkflowDefinition['inputs']
  currentWorkflowOutputs?: WorkflowDefinition['outputs']
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
  /** Opens the "Insert snippet…" dialog. */
  onInsertSnippet: () => void
}

export function InspectorPanel({
  selectedNode,
  selectedEdge,
  runNodes,
  validationIssues,
  tools,
  workflowNodes,
  workflowEdges,
  currentWorkflowName,
  currentWorkflowInputs,
  currentWorkflowOutputs,
  onUpdateNodeConfig,
  onUpdateNodeType,
  onUpdateEdgeCondition,
  onInsertSnippet,
}: InspectorPanelProps) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const entityRef = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<AuthoringFocusRequest | null>(null)
  const nodeStatus = selectedNode ? runNodes.find(node => node.nodeId === selectedNode.id) : null
  const nodeIssues = selectedNode ? validationIssues.filter(issue => issue.nodeId === selectedNode.id) : []

  // A stale parse error from node A must not linger under node B's card —
  // the error banner describes the PREVIOUS selection's JSON, not this one's.
  const selectedNodeId = selectedNode?.id ?? null
  React.useEffect(() => {
    setJsonError(null)
  }, [selectedNodeId])

  useEffect(() => {
    const pending = consumeAuthoringFocus()
    if (pending) setFocusRequest(pending)
    const onFocusRequest = (event: Event) => {
      const request = consumeAuthoringFocus() ?? parseAuthoringFocusEvent(event)
      if (request) setFocusRequest(request)
    }
    window.addEventListener(AUTHORING_FOCUS_EVENT, onFocusRequest)
    return () => window.removeEventListener(AUTHORING_FOCUS_EVENT, onFocusRequest)
  }, [])

  useEffect(() => {
    if (!focusRequest) return
    const matchesNode = focusRequest.kind === 'node' && selectedNode?.id === focusRequest.id
    const matchesEdge = focusRequest.kind === 'edge' && selectedEdge?.id === focusRequest.id
    if (!matchesNode && !matchesEdge) return
    entityRef.current?.focus({ preventScroll: false })
    setFocusRequest(null)
  }, [focusRequest, selectedEdge?.id, selectedNode?.id])

  // Operators paste node ids into logs / run filters; a one-click copy beats
  // hand-selecting the mono text. Degrades to an error toast where the
  // Clipboard API is unavailable (non-secure context).
  const copyNodeId = (id: string) => {
    if (!navigator.clipboard) {
      addToast(t('rightPanel.inspector.idCopyFailed'), 'error')
      return
    }
    navigator.clipboard.writeText(id).then(
      () => addToast(t('rightPanel.inspector.idCopied'), 'success'),
      () => addToast(t('rightPanel.inspector.idCopyFailed'), 'error'),
    )
  }

  if (selectedNode) {
    const status = nodeStatus?.status ?? 'draft'
    const failureMessage = status === 'failed' ? pickErrorMessage(nodeStatus?.errorJson) : null
    const failureDuration = status === 'failed' ? formatNodeDuration(nodeStatus?.startedAt, nodeStatus?.finishedAt) : null
    const failureMeta: string[] = []
    if (status === 'failed') {
      if (typeof nodeStatus?.attempts === 'number' && nodeStatus.attempts > 0) {
        failureMeta.push(t('rightPanel.runs.nodeAttempt', { count: nodeStatus.attempts }) as string)
      }
      if (failureDuration) failureMeta.push(failureDuration)
    }

    return (
      <section ref={entityRef} className="panel-card" tabIndex={-1} data-testid={`inspector-node-${selectedNode.id}`}>
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('rightPanel.inspector.stepKicker')}</div>
            <h3>{getNodeLabel(selectedNode.data.type)}</h3>
            <p className="helper-text mono">
              {currentWorkflowName ? `${currentWorkflowName} › ` : ''}{t('rightPanel.inspector.stepIdLabel', { id: selectedNode.id })}
              <button
                type="button"
                className="inspector-id-copy"
                onClick={() => copyNodeId(selectedNode.id)}
                aria-label={t('rightPanel.inspector.copyId') as string}
                title={t('rightPanel.inspector.copyId') as string}
              >
                <Copy size={12} aria-hidden="true" />
              </button>
            </p>
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

        {status === 'failed' && (failureMessage || failureMeta.length > 0) && (
          <div className="we-failed-node" data-testid="inspector-failed-node">
            {failureMeta.length > 0 && (
              <span className="helper-text we-failed-node__meta">{failureMeta.join(' · ')}</span>
            )}
            {failureMessage && (
              <p className="we-failed-node__error" title={failureMessage}>{failureMessage}</p>
            )}
          </div>
        )}

        <AiUsageFooter stateJson={nodeStatus?.stateJson} />


        <div className="form-grid">
          <label className="field-label" htmlFor="node-type">{t('rightPanel.inspector.stepKindLabel')}</label>
          <select id="node-type" className="text-field" value={selectedNode.data.type} onChange={event => onUpdateNodeType(event.target.value)}>
            {nodeTypes.map(type => <option key={type} value={type}>{getNodeLabel(type)}</option>)}
          </select>
          <span className="helper-text helper-text--hint">{t('rightPanel.inspector.stepKindWarning')}</span>
        </div>

        <QuickConfigEditor
          key={selectedNode.id}
          nodeId={selectedNode.id}
          type={selectedNode.data.type}
          config={selectedNode.data.config ?? {}}
          tools={tools}
          workflowNodes={workflowNodes}
          workflowEdges={workflowEdges}
          workflowInputs={currentWorkflowInputs}
          onUpdate={onUpdateNodeConfig}
        />

        <button
          type="button"
          className="we-btn we-btn--ghost we-inspector-snippet-btn"
          data-testid="inspector-insert-snippet"
          onClick={onInsertSnippet}
        >
          <Layers size={14} aria-hidden="true" />
          <span>{t('snippets.menu.trigger')}</span>
        </button>

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
      <section ref={entityRef} className="panel-card" tabIndex={-1} data-testid={`inspector-edge-${selectedEdge.id}`}>
        <div className="section-kicker">{t('rightPanel.inspector.pathKicker')}</div>
        <h3>{t('rightPanel.inspector.pathTitle', { source: selectedEdge.source, target: selectedEdge.target })}</h3>
        <ExpressionAssistant
          key={selectedEdge.id}
          id="edge-condition"
          label={t('rightPanel.inspector.runOnlyWhen') as string}
          value={selectedEdge.data?.condition ?? ''}
          onChange={(value) => onUpdateEdgeCondition(selectedEdge.id, value)}
          nodes={workflowNodes}
          edges={workflowEdges}
          targetNodeId={selectedEdge.source}
          mode="edge"
          workflowInputs={currentWorkflowInputs}
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
          <button
            type="button"
            className="we-btn we-btn--ghost we-inspector-snippet-btn"
            data-testid="inspector-insert-snippet-empty"
            onClick={onInsertSnippet}
          >
            <Layers size={14} aria-hidden="true" />
            <span>{t('snippets.menu.trigger')}</span>
          </button>
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
