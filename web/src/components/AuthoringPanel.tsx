import { useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, GitBranch, MessageSquareText, Settings2, ShieldCheck, Sparkles, Wrench } from 'lucide-react'

import { useT } from '../i18n'
import type {
  AiAuthoringAction,
  AiReviewIssue,
  ReadinessResult,
  RunNode,
  SavedWorkflow,
  ToolSchema,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowGraphEdge,
  WorkflowGraphNode,
} from '../types'
import { useAuthoringScopeRequest, type AuthoringScope } from './authoring-focus-bus'
import { buildAuthoringProblems } from './authoring-problems'
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { InspectorPanel } from './InspectorPanel'
import { PanelChrome } from './panel-primitives'
import { WorkflowOperationsPanel } from './WorkflowOperationsPanel'
import { Button } from './ui/Button'

export type AuthoringPanelModel = {
  runNodes: RunNode[]
  selectedNode: WorkflowGraphNode | null
  selectedEdge: WorkflowGraphEdge | null
  workflowNodes: WorkflowGraphNode[]
  workflowEdges: WorkflowGraphEdge[]
  validationIssues: ValidationIssue[]
  readinessResult: ReadinessResult | null
  aiReviewIssues: AiReviewIssue[]
  tools: ToolSchema[]
  workflows: SavedWorkflow[]
  currentWorkflowId: string
  currentWorkflowName: string
  currentWorkflowInputs?: WorkflowDefinition['inputs']
  currentWorkflowOutputs?: WorkflowDefinition['outputs']
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
  onUpdateEdgeOnError: (edgeId: string, onError: boolean) => void
  onValidateWorkflow(): Promise<boolean>
  onInsertSnippet: () => void
}

export function AuthoringPanel({
  model,
  canWrite,
  canUseAi,
  onOpenAiAction,
}: {
  model: AuthoringPanelModel
  canWrite: boolean
  canUseAi: boolean
  onOpenAiAction: (action: AiAuthoringAction) => void
}) {
  const { t } = useT()
  const hasSelection = Boolean(model.selectedNode || model.selectedEdge)
  const problemCount = useMemo(() => buildAuthoringProblems({
    validationIssues: model.validationIssues,
    readiness: model.readinessResult,
    aiReviewIssues: model.aiReviewIssues,
    workflowEdges: model.workflowEdges,
  }).length, [model.aiReviewIssues, model.readinessResult, model.validationIssues, model.workflowEdges])
  const [scope, setScope] = useState<AuthoringScope>(hasSelection ? 'step' : 'workflow')

  // Reset on a selection change only: a mount must not undo a jump's requested scope.
  const selectionKey = `${model.selectedNode?.id ?? ''}|${model.selectedEdge?.id ?? ''}`
  const [lastSelectionKey, setLastSelectionKey] = useState(selectionKey)
  if (selectionKey !== lastSelectionKey) {
    setLastSelectionKey(selectionKey)
    setScope(hasSelection ? 'step' : 'workflow')
  }
  useAuthoringScopeRequest(setScope)

  const actions: readonly {
    action: AiAuthoringAction
    icon: ReactNode
    labelKey: string
  }[] = [
    { action: 'generate', icon: <Sparkles size={13} />, labelKey: 'authoring.ai.generate' },
    { action: 'explain', icon: <MessageSquareText size={13} />, labelKey: 'authoring.ai.explain' },
    { action: 'review', icon: <ShieldCheck size={13} />, labelKey: 'authoring.ai.review' },
    { action: 'fix', icon: <Wrench size={13} />, labelKey: 'authoring.ai.fix' },
  ]

  return (
    <PanelChrome
      title={t('authoring.title')}
      description={t('authoring.description')}
    >
      <nav className="authoring-scope-nav" aria-label={t('authoring.scope.aria')}>
        <button
          type="button"
          data-active={scope === 'step' ? 'true' : 'false'}
          aria-current={scope === 'step' ? 'page' : undefined}
          disabled={!hasSelection}
          onClick={() => setScope('step')}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span>{t('authoring.scope.step')}</span>
        </button>
        <button
          type="button"
          data-active={scope === 'workflow' ? 'true' : 'false'}
          aria-current={scope === 'workflow' ? 'page' : undefined}
          onClick={() => setScope('workflow')}
        >
          <Settings2 size={13} aria-hidden="true" />
          <span>{t('authoring.scope.workflow')}</span>
        </button>
        <button
          type="button"
          data-active={scope === 'problems' ? 'true' : 'false'}
          data-shortcut="authoring-problems"
          aria-current={scope === 'problems' ? 'page' : undefined}
          onClick={() => setScope('problems')}
        >
          <CheckCircle2 size={13} aria-hidden="true" />
          <span>{t('authoring.scope.problems')}</span>
          {problemCount > 0 && <small>{problemCount}</small>}
        </button>
      </nav>

      {canUseAi && (
        <section className="authoring-ai-actions" aria-label={t('authoring.ai.title')} data-testid="authoring-ai-toolbar">
          {actions.map((item) => (
            <Button
              size="sm"
              key={item.action}
              leadingIcon={item.icon}
              data-testid={`authoring-ai-${item.action}`}
              onClick={() => onOpenAiAction(item.action)}
            >
              {t(item.labelKey)}
            </Button>
          ))}
        </section>
      )}

      {scope === 'problems' && (
        <AuthoringProblemsPanel
          validationIssues={model.validationIssues}
          readiness={model.readinessResult}
          aiReviewIssues={model.aiReviewIssues}
          workflowEdges={model.workflowEdges}
          onValidate={model.onValidateWorkflow}
        />
      )}

      {(scope === 'workflow' || (scope === 'step' && hasSelection)) && (
        <InspectorPanel
          readOnly={!canWrite}
          selectedNode={scope === 'step' ? model.selectedNode : null}
          selectedEdge={scope === 'step' ? model.selectedEdge : null}
          runNodes={model.runNodes}
          validationIssues={model.validationIssues}
          tools={model.tools}
          workflows={model.workflows}
          workflowNodes={model.workflowNodes}
          workflowEdges={model.workflowEdges}
          currentWorkflowId={model.currentWorkflowId}
          currentWorkflowName={model.currentWorkflowName}
          currentWorkflowInputs={model.currentWorkflowInputs}
          currentWorkflowOutputs={model.currentWorkflowOutputs}
          onUpdateNodeConfig={model.onUpdateNodeConfig}
          onUpdateNodeType={model.onUpdateNodeType}
          onUpdateEdgeCondition={model.onUpdateEdgeCondition}
          onUpdateEdgeOnError={model.onUpdateEdgeOnError}
          onInsertSnippet={model.onInsertSnippet}
        />
      )}

      {scope === 'workflow' && <WorkflowOperationsPanel readOnly={!canWrite} />}
    </PanelChrome>
  )
}
