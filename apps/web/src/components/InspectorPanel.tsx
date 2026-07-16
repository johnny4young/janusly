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
import { Copy, CopyPlus, GitBranch, Layers } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, RunNode, SavedWorkflow, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { formatNodeDuration, formatStatusLabel, getNodeConfigSummary, getNodeLabel, nodeTypes } from '../constants'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { AiUsageFooter } from './AiUsageFooter'
import { useConfirm } from './ConfirmDialog'
import { pickErrorMessage } from './recovery-dialog/helpers'
import { QuickConfigEditor } from './QuickConfigEditor'
import { ExpressionAssistant } from './ExpressionAssistant'
import {
  AUTHORING_FOCUS_EVENT,
  consumeAuthoringFocus,
  parseAuthoringFocusEvent,
  type AuthoringFocusRequest,
} from './authoring-focus-bus'

const WorkflowIoEditor = React.lazy(() => import('./WorkflowIoEditor').then(module => ({ default: module.WorkflowIoEditor })))

type InspectorPanelProps = {
  selectedNode: WorkflowGraphNode | null
  selectedEdge: WorkflowGraphEdge | null
  runNodes: RunNode[]
  validationIssues: ValidationIssue[]
  tools: ToolSchema[]
  workflows: SavedWorkflow[]
  workflowNodes: WorkflowGraphNode[]
  workflowEdges: WorkflowGraphEdge[]
  currentWorkflowId?: string
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
  workflows,
  workflowNodes,
  workflowEdges,
  currentWorkflowId,
  currentWorkflowName,
  currentWorkflowInputs,
  currentWorkflowOutputs,
  onUpdateNodeConfig,
  onUpdateNodeType,
  onUpdateEdgeCondition,
  onInsertSnippet,
}: InspectorPanelProps) {
  const { t } = useT()
  const confirm = useConfirm()
  const addToast = useWorkflowStore(state => state.addToast)
  const updateNodeLabel = useWorkflowStore(state => state.updateNodeLabel)
  const duplicateNode = useWorkflowStore(state => state.duplicateNode)
  const updateWorkflowInputs = useWorkflowStore(state => state.updateWorkflowInputs)
  const updateWorkflowOutputs = useWorkflowStore(state => state.updateWorkflowOutputs)
  const currentWorkflowTemplatePolicy = useWorkflowStore(state => state.currentWorkflowTemplatePolicy)
  const updateWorkflowTemplatePolicy = useWorkflowStore(state => state.updateWorkflowTemplatePolicy)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonDraft, setJsonDraft] = useState(() => selectedNode ? JSON.stringify(selectedNode.data.config, null, 2) : '')
  const [typeChangePending, setTypeChangePending] = useState(false)
  const typeChangePendingRef = useRef(false)
  const entityRef = useRef<HTMLElement | null>(null)
  const selectedNodeIdRef = useRef<string | null>(selectedNode?.id ?? null)
  selectedNodeIdRef.current = selectedNode?.id ?? null
  const [focusRequest, setFocusRequest] = useState<AuthoringFocusRequest | null>(null)
  const nodeStatus = selectedNode ? runNodes.find(node => node.nodeId === selectedNode.id) : null
  const nodeIssues = selectedNode ? validationIssues.filter(issue => issue.nodeId === selectedNode.id) : []

  // Keep Advanced JSON aligned with quick edits and kind changes on the SAME
  // node. The old uncontrolled textarea only remounted for a different node id,
  // so it could display (and later write back) stale config after a kind swap.
  const selectedNodeId = selectedNode?.id ?? null
  const selectedNodeType = selectedNode?.data.type ?? null
  const selectedNodeConfig = selectedNode?.data.config ?? null
  React.useEffect(() => {
    setJsonError(null)
    setJsonDraft(selectedNodeConfig ? JSON.stringify(selectedNodeConfig, null, 2) : '')
  }, [selectedNodeConfig, selectedNodeId, selectedNodeType])

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

  const requestNodeTypeChange = async (nextType: string) => {
    if (!selectedNode || nextType === selectedNode.data.type || typeChangePendingRef.current) return
    const sourceNodeId = selectedNode.id
    typeChangePendingRef.current = true
    setTypeChangePending(true)
    try {
      const accepted = await confirm({
        title: t('rightPanel.inspector.changeKindTitle'),
        body: t('rightPanel.inspector.changeKindBody', {
          from: getNodeLabel(selectedNode.data.type),
          to: getNodeLabel(nextType),
        }),
        confirmLabel: t('rightPanel.inspector.changeKindConfirm'),
      })
      if (accepted && selectedNodeIdRef.current === sourceNodeId) onUpdateNodeType(nextType)
    } finally {
      typeChangePendingRef.current = false
      setTypeChangePending(false)
    }
  }

  if (selectedNode) {
    const status = nodeStatus?.status ?? 'draft'
    const failureMessage = status === 'failed' ? pickErrorMessage(nodeStatus?.errorJson) : null
    const failureDuration = status === 'failed' ? formatNodeDuration(nodeStatus?.startedAt, nodeStatus?.finishedAt) : null
    const failureMeta: string[] = []
    if (status === 'failed') {
      if (typeof nodeStatus?.attempts === 'number' && nodeStatus.attempts > 0) {
        failureMeta.push(t('rightPanel.runs.nodeAttempt', { count: nodeStatus.attempts }))
      }
      if (failureDuration) failureMeta.push(failureDuration)
    }

    return (
      <section ref={entityRef} className="we-card" tabIndex={-1} data-testid={`inspector-node-${selectedNode.id}`}>
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('rightPanel.inspector.stepKicker')}</div>
            <h3>{selectedNode.data.label?.trim() || getNodeLabel(selectedNode.data.type)}</h3>
            <p className="helper-text mono">
              {currentWorkflowName ? `${currentWorkflowName} › ` : ''}{t('rightPanel.inspector.stepIdLabel', { id: selectedNode.id })}
              <button
                type="button"
                className="inspector-id-copy"
                onClick={() => copyNodeId(selectedNode.id)}
                aria-label={t('rightPanel.inspector.copyId')}
                title={t('rightPanel.inspector.copyId')}
              >
                <Copy size={12} aria-hidden="true" />
              </button>
            </p>
            <p className="helper-text">{getNodeConfigSummary(selectedNode.data.type, selectedNode.data.config ?? {})}</p>
          </div>
          <div className="inspector-header-pills">
            <span className="status-pill" data-status={status}>{formatStatusLabel(status)}</span>
            <span
              className="we-pill"
              data-tone={nodeIssues.length ? 'danger' : 'success'}
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
          <label className="field-label" htmlFor="node-label">{t('rightPanel.inspector.stepNameLabel')}</label>
          <input
            id="node-label"
            className="text-field"
            value={selectedNode.data.label ?? ''}
            maxLength={80}
            placeholder={getNodeLabel(selectedNode.data.type)}
            aria-describedby="node-label-helper"
            onChange={(event) => updateNodeLabel(selectedNode.id, event.target.value)}
          />
          <span id="node-label-helper" className="helper-text helper-text--hint">{t('rightPanel.inspector.stepNameHelper')}</span>
          <label className="field-label" htmlFor="node-type">{t('rightPanel.inspector.stepKindLabel')}</label>
          <select
            id="node-type"
            className="text-field"
            value={selectedNode.data.type}
            aria-busy={typeChangePending}
            onChange={(event) => { void requestNodeTypeChange(event.target.value) }}
          >
            {nodeTypes.map(type => <option key={type} value={type}>{getNodeLabel(type)}</option>)}
          </select>
          <span className="helper-text helper-text--hint">{t('rightPanel.inspector.stepKindWarning')}</span>
        </div>

        <button
          type="button"
          className="we-btn we-btn--ghost we-inspector-duplicate-btn"
          onClick={() => duplicateNode(selectedNode.id)}
        >
          <CopyPlus size={14} aria-hidden="true" />
          <span>{t('rightPanel.inspector.duplicateStep')}</span>
        </button>

        <QuickConfigEditor
          key={selectedNode.id}
          nodeId={selectedNode.id}
          type={selectedNode.data.type}
          config={selectedNode.data.config ?? {}}
          tools={tools}
          workflowNodes={workflowNodes}
          workflowEdges={workflowEdges}
          workflowInputs={currentWorkflowInputs}
          workflows={workflows}
          currentWorkflowId={currentWorkflowId}
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
            id="node-config"
            className="code-field"
            value={jsonDraft}
            onChange={(event) => setJsonDraft(event.target.value)}
            onBlur={(event) => {
              try {
                const parsed = JSON.parse(event.target.value) as Record<string, unknown>
                onUpdateNodeConfig(parsed)
                setJsonError(null)
              } catch (error) {
                setJsonError(error instanceof Error ? error.message : (t('rightPanel.inspector.invalidJson')))
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
      <section ref={entityRef} className="we-card" tabIndex={-1} data-testid={`inspector-edge-${selectedEdge.id}`}>
        <div className="section-kicker">{t('rightPanel.inspector.pathKicker')}</div>
        <h3>{t('rightPanel.inspector.pathTitle', { source: selectedEdge.source, target: selectedEdge.target })}</h3>
        <ExpressionAssistant
          key={selectedEdge.id}
          id="edge-condition"
          label={t('rightPanel.inspector.runOnlyWhen')}
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

  return (
    <>
      <React.Suspense fallback={<section className="we-card"><p className="helper-text">{t('common.working')}</p></section>}>
        <WorkflowIoEditor
          workflowId={currentWorkflowId ?? 'unsaved-workflow'}
          inputs={currentWorkflowInputs}
          outputs={currentWorkflowOutputs}
          templatePolicy={currentWorkflowTemplatePolicy}
          onChangeInputs={updateWorkflowInputs}
          onChangeOutputs={updateWorkflowOutputs}
          onChangeTemplatePolicy={updateWorkflowTemplatePolicy}
        />
      </React.Suspense>
      <section className="we-card">
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
