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
import { pickErrorMessage } from './recovery-dialog/recovery-dialog-model'
import { QuickConfigEditor } from './QuickConfigEditor'
import { BranchRuleEditor } from './BranchRuleEditor'
import {
  AUTHORING_FOCUS_EVENT,
  consumeAuthoringFocus,
  parseAuthoringFocusEvent,
  type AuthoringFocusRequest,
} from './authoring-focus-bus'
import { loadWorkflowIoEditor } from './workflow-io-loader'
import { Button } from './ui/Button'
import { FieldStack, FormActions, FormDisclosure, FormField } from './ui/Form'
import { SwitchField } from './ui/SwitchField'

const WorkflowIoEditor = React.lazy(() => loadWorkflowIoEditor().then(module => ({ default: module.WorkflowIoEditor })))

type InspectorPanelProps = {
  readOnly?: boolean
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
  onUpdateEdgeOnError: (edgeId: string, onError: boolean) => void
  /** Opens the "Insert snippet…" dialog. */
  onInsertSnippet: () => void
}

export function InspectorPanel({
  readOnly = false,
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
  onUpdateEdgeOnError,
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
      <section ref={entityRef} className="we-card ui-inspector-card" tabIndex={-1} data-testid={`inspector-node-${selectedNode.id}`}>
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
        <FieldStack disabled={readOnly} className="ui-inspector-fields">
          <div className="ui-inspector-basics">
            <FormField
              id="node-label"
              label={t('rightPanel.inspector.stepNameLabel')}
              hint={t('rightPanel.inspector.stepNameHelper')}
            >
              {controlProps => (
                <input
                  {...controlProps}
                  value={selectedNode.data.label ?? ''}
                  maxLength={80}
                  placeholder={getNodeLabel(selectedNode.data.type)}
                  onChange={(event) => updateNodeLabel(selectedNode.id, event.target.value)}
                />
              )}
            </FormField>
            <FormField
              id="node-type"
              label={t('rightPanel.inspector.stepKindLabel')}
              hint={t('rightPanel.inspector.stepKindWarning')}
            >
              {controlProps => (
                <select
                  {...controlProps}
                  value={selectedNode.data.type}
                  aria-busy={typeChangePending}
                  disabled={typeChangePending}
                  onChange={(event) => { void requestNodeTypeChange(event.target.value) }}
                >
                  {nodeTypes.map(type => <option key={type} value={type}>{getNodeLabel(type)}</option>)}
                </select>
              )}
            </FormField>
          </div>

          <FormActions className="ui-inspector-actions">
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<CopyPlus size={14} />}
              onClick={() => duplicateNode(selectedNode.id)}
            >
              {t('rightPanel.inspector.duplicateStep')}
            </Button>
          </FormActions>

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

          <Button
            variant="secondary"
            size="sm"
            className="ui-inspector-snippet"
            data-testid="inspector-insert-snippet"
            leadingIcon={<Layers size={14} />}
            onClick={onInsertSnippet}
          >
            {t('snippets.menu.trigger')}
          </Button>

          <FormDisclosure summary={t('rightPanel.inspector.advancedJsonSummary')} className="ui-inspector-json">
            <p id="node-config-hint" className="ui-field__hint">{t('rightPanel.inspector.advancedJsonHelper')}</p>
            <textarea
              id="node-config"
              className="ui-config-code ui-inspector-json__control"
              data-ui-control
              value={jsonDraft}
              aria-label={t('rightPanel.inspector.advancedJsonSummary')}
              aria-describedby="node-config-hint"
              aria-invalid={Boolean(jsonError) || undefined}
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
            {jsonError && <div className="ui-field__error" role="alert">{jsonError}</div>}
          </FormDisclosure>
        </FieldStack>

        {nodeIssues.map(issue => <div key={`${issue.code}-${issue.message}`} className="issue issue-error">{issue.message}</div>)}
      </section>
    )
  }

  if (selectedEdge) {
    return (
      <section ref={entityRef} className="we-card ui-inspector-card" tabIndex={-1} data-testid={`inspector-edge-${selectedEdge.id}`}>
        <div className="section-kicker">{t('rightPanel.inspector.pathKicker')}</div>
        <h3>{t('rightPanel.inspector.pathTitle', { source: selectedEdge.source, target: selectedEdge.target })}</h3>
        <FieldStack disabled={readOnly} className="ui-inspector-fields">
          <SwitchField
            checked={Boolean(selectedEdge.data?.onError)}
            label={t('rightPanel.inspector.onErrorToggle')}
            hint={t('rightPanel.inspector.onErrorHint')}
            onChange={(event) => onUpdateEdgeOnError(selectedEdge.id, event.target.checked)}
          />
          {!selectedEdge.data?.onError && (
            <BranchRuleEditor
              key={selectedEdge.id}
              id={`edge-${selectedEdge.id}-branch-rule`}
              label={t('rightPanel.inspector.runOnlyWhen')}
              value={selectedEdge.data?.condition ?? ''}
              onChange={(value) => onUpdateEdgeCondition(selectedEdge.id, value)}
              nodes={workflowNodes}
              edges={workflowEdges}
              targetNodeId={selectedEdge.source}
              mode="edge"
              workflowInputs={currentWorkflowInputs}
            />
          )}
        </FieldStack>
      </section>
    )
  }

  return (
    <>
      <React.Suspense fallback={<section className="we-card"><p className="helper-text">{t('common.working')}</p></section>}>
        <FieldStack disabled={readOnly}>
          <WorkflowIoEditor
            workflowId={currentWorkflowId ?? 'unsaved-workflow'}
            inputs={currentWorkflowInputs}
            outputs={currentWorkflowOutputs}
            templatePolicy={currentWorkflowTemplatePolicy}
            onChangeInputs={updateWorkflowInputs}
            onChangeOutputs={updateWorkflowOutputs}
            onChangeTemplatePolicy={updateWorkflowTemplatePolicy}
          />
        </FieldStack>
      </React.Suspense>
      <section className="we-card">
        <div className="empty-panel">
          <GitBranch size={24} aria-hidden="true" />
          <strong>{t('rightPanel.inspector.emptyTitle')}</strong>
          <p>{t('rightPanel.inspector.emptyBody')}</p>
          <Button
            variant="secondary"
            size="sm"
            className="ui-inspector-snippet"
            data-testid="inspector-insert-snippet-empty"
            leadingIcon={<Layers size={14} />}
            onClick={onInsertSnippet}
          >
            {t('snippets.menu.trigger')}
          </Button>
        </div>
      </section>
    </>
  )
}
