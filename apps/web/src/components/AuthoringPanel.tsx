import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
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
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { InspectorPanel } from './InspectorPanel'
import { PanelChrome } from './panel-primitives'

const VersionHistoryPanel = lazy(() => import('./VersionHistoryPanel').then((module) => ({ default: module.VersionHistoryPanel })))
const WorkflowRolloutPanel = lazy(() => import('./WorkflowRolloutPanel').then((module) => ({ default: module.WorkflowRolloutPanel })))
const WorkflowSloPanel = lazy(() => import('./WorkflowSloPanel').then((module) => ({ default: module.WorkflowSloPanel })))
const ScheduleHistoryPanel = lazy(() => import('./ScheduleHistoryPanel').then((module) => ({ default: module.ScheduleHistoryPanel })))
const WorkflowMetadataPanel = lazy(() => import('./WorkflowMetadataPanel').then((module) => ({ default: module.WorkflowMetadataPanel })))

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
  onValidateWorkflow(): Promise<boolean>
  onInsertSnippet: () => void
}

type AuthoringScope = 'step' | 'workflow' | 'problems'

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
  const problemCount = model.validationIssues.length
    + model.aiReviewIssues.length
    + (model.readinessResult?.issues.length ?? 0)
  const [scope, setScope] = useState<AuthoringScope>(hasSelection ? 'step' : 'workflow')

  useEffect(() => {
    setScope(hasSelection ? 'step' : 'workflow')
  }, [hasSelection, model.selectedEdge?.id, model.selectedNode?.id])

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
      icon={<GitBranch size={18} />}
    >
      {canUseAi && (
        <section className="authoring-ai-actions" aria-label={t('authoring.ai.aria')}>
          <div>
            <strong>{t('authoring.ai.title')}</strong>
            <span>{t('authoring.ai.body')}</span>
          </div>
          <div className="authoring-ai-actions__buttons">
            {actions.map((item) => (
              <button
                key={item.action}
                type="button"
                className="small-command"
                onClick={() => onOpenAiAction(item.action)}
              >
                {item.icon}
                <span>{t(item.labelKey as never)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

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
          aria-current={scope === 'problems' ? 'page' : undefined}
          onClick={() => setScope('problems')}
        >
          <CheckCircle2 size={13} aria-hidden="true" />
          <span>{t('authoring.scope.problems')}</span>
          {problemCount > 0 && <small>{problemCount}</small>}
        </button>
      </nav>

      {scope === 'problems' && (
        <AuthoringProblemsPanel
          validationIssues={model.validationIssues}
          readiness={model.readinessResult}
          aiReviewIssues={model.aiReviewIssues}
          workflowEdges={model.workflowEdges}
          onValidate={model.onValidateWorkflow}
          onOpenProblem={() => setScope('step')}
        />
      )}

      {scope === 'step' && hasSelection && (
        <InspectorPanel
          readOnly={!canWrite}
          selectedNode={model.selectedNode}
          selectedEdge={model.selectedEdge}
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
          onInsertSnippet={model.onInsertSnippet}
        />
      )}

      {scope === 'workflow' && (
        <>
          <InspectorPanel
            readOnly={!canWrite}
            selectedNode={null}
            selectedEdge={null}
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
            onInsertSnippet={model.onInsertSnippet}
          />
          <Suspense fallback={null}>
            <VersionHistoryPanel />
            <WorkflowRolloutPanel readOnly={!canWrite} />
            <WorkflowSloPanel readOnly={!canWrite} />
            <ScheduleHistoryPanel />
            <WorkflowMetadataPanel readOnly={!canWrite} />
          </Suspense>
        </>
      )}
    </PanelChrome>
  )
}
