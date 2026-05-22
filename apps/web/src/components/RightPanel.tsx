/**
 * Right-side workspace panel — the heavy router that switches between
 * Inspector, Templates, Tools, Credentials, Runs, Multi-agent timeline,
 * AI Copilot, Members, Reasoning, and Workflows tabs. Each tab is a small
 * inner component (`InspectorPanel`, `TemplatesPanel`, …) that owns its
 * own data fetch + interactions.
 *
 * Used by `App.tsx` (top-level routing on `tab`).
 *
 * Invariants:
 * - Mutations that invalidate server data call `bumpPlatformVersion()` so
 *   sibling panels refetch (AGENTS.md cross-panel reactivity).
 * - The `AiUsageFooter` is exported here so the per-node usage
 *   surface can be unit-tested without mounting the full panel.
 * - Web deps locked to the AGENTS.md whitelist plus
 *   `@janusly/shared/src/status` for zero-dep lifecycle guards. Don't add
 *   radix / cva / clsx / tailwind-merge / shadcn here.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Activity, Boxes, CheckCircle2, Database, Download, FlaskConical, GitBranch, KeyRound, Layers3, ListChecks, LockKeyhole, Plug, RefreshCw, Send, ShieldCheck, Users, Workflow } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, AiHealth, AiMode, Credential, JsonObject, McpConnection, McpToolDescriptor, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowInputSchemaShape } from '../types'
import { MultiAgentTimeline } from '../MultiAgentTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { MembersPanel } from './MembersPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { WorkflowSloPanel } from './WorkflowSloPanel'
import { DeadLettersPanel, type DeadLetter } from './DeadLettersPanel'
import { RunExplainChat } from './RunExplainChat'
import { AiCopilotPanel } from './AiCopilotPanel'
import { OperationsPanel } from './OperationsPanel'
import { HumanFormDialog } from './HumanFormDialog'
import { ReplayLabDialog } from './ReplayLabDialog'
import { ReplayLabForkDialog } from './ReplayLabForkDialog'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'
import { formatStatusLabel, getNodeConfigSummary, getNodeLabel, nodeTypes } from '../constants'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { api, downloadFromApi } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, Trans, tTemplateCategory, tTemplateDescription, tTemplateName, tToolDescription, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

type RightPanelProps = {
  tab: ActiveTab
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  runNodes: RunNode[]
  selectedNode: WorkflowGraphNode | null
  selectedEdge: WorkflowGraphEdge | null
  validationIssues: ValidationIssue[]
  tools: ToolSchema[]
  templates: Template[]
  credentials: Credential[]
  runs: RunSummary[]
  activeRunId?: string | null
  deadLetters: DeadLetter[]
  usage: Record<string, number>
  aiHealth: AiHealth | null
  currentWorkflowName: string
  /** Declared workflow input shape; rendered in the no-selection inspector card. */
  currentWorkflowInputs?: WorkflowDefinition['inputs']
  /** Declared workflow output projection; rendered alongside `currentWorkflowInputs`. */
  currentWorkflowOutputs?: WorkflowDefinition['outputs']
  onOpenWorkflow: (id: string) => void
  onUseTemplate: (workflow: WorkflowDefinition) => void
  onInstallPlugin: (pluginId: string) => void
  onCreateCredential: (credential: { name: string; kind: string; secretRef: string }) => void
  onOpenRun: (id: string) => void
  onRefreshPlatform: () => void
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
  onApproveNode: (nodeId: string) => void
  onSubmitHumanForm: (nodeId: string, input: unknown, resumeToken: string) => Promise<string[] | void> | string[] | void
  onReplayNode: (nodeId: string) => void
  onCancelActiveRun?: () => void | Promise<void>
  onReplayDeadLetter: (id: string) => void
  onResolveDeadLetter: (id: string) => void
  onGenerateWorkflow: (prompt: string) => Promise<{ mode: AiMode; workflow: WorkflowDefinition }>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string }>
  onReviewWorkflow: () => Promise<{
    mode: AiMode
    review: { status: 'pass' | 'warn' | 'fail'; issues: Array<{ code: string; severity: 'info' | 'warn' | 'fail'; message: string; nodeId?: string; edgeId?: string; rationale: string; suggestion: string }> }
    model?: string
    aiError?: string
  }>
  onOpenTab: (tab: ActiveTab) => void
}

/** Tab-aware right-side panel router — picks the inner panel component for
 *  the active tab. The 'home' tab is intentionally handled by `App.tsx`
 *  at the layout level (panel slot is null, Recovery Center goes in the main area
 *  so it has hero-page real estate); this dispatcher never receives it. */
export function RightPanel(props: RightPanelProps) {
  const { t } = useT()
  if (props.tab === 'copilot') return (
    <AiCopilotPanel
      health={props.aiHealth}
      workflowName={props.currentWorkflowName}
      onGenerateWorkflow={props.onGenerateWorkflow}
      onExplainWorkflow={props.onExplainWorkflow}
      onReviewWorkflow={props.onReviewWorkflow}
      onOpenRuns={() => props.onOpenTab('runs')}
      onOpenTemplates={() => props.onOpenTab('templates')}
    />
  )
  if (props.tab === 'multiAgent') return (
    <PanelChrome title={t('rightPanel.multiAgent.title') as string} description={t('rightPanel.multiAgent.description') as string} icon={<Layers3 size={18} />}>
      <MultiAgentTimeline events={props.events} eventsHasMore={props.eventsHasMore} onLoadOlderEvents={props.onLoadOlderEvents} />
    </PanelChrome>
  )
  if (props.tab === 'workflows') return (
    <PanelChrome title={t('rightPanel.workflows.title') as string} description={t('rightPanel.workflows.description') as string} icon={<Database size={18} />}>
      <WorkflowsDashboard onOpen={props.onOpenWorkflow} />
    </PanelChrome>
  )
  if (props.tab === 'operations') return <OperationsPanel />
  if (props.tab === 'members') return (
    <PanelChrome title={t('rightPanel.members.title') as string} description={t('rightPanel.members.description') as string} icon={<Users size={18} />}>
      <MembersPanel />
    </PanelChrome>
  )
  if (props.tab === 'inspector') return (
    <PanelChrome title={t('rightPanel.inspector.title') as string} description={t('rightPanel.inspector.description') as string} icon={<GitBranch size={18} />}>
      <InspectorPanel
        selectedNode={props.selectedNode}
        selectedEdge={props.selectedEdge}
        runNodes={props.runNodes}
        validationIssues={props.validationIssues}
        tools={props.tools}
        currentWorkflowInputs={props.currentWorkflowInputs}
        currentWorkflowOutputs={props.currentWorkflowOutputs}
        onUpdateNodeConfig={props.onUpdateNodeConfig}
        onUpdateNodeType={props.onUpdateNodeType}
        onUpdateEdgeCondition={props.onUpdateEdgeCondition}
      />
      <VersionHistoryPanel />
      <WorkflowSloPanel />
    </PanelChrome>
  )
  if (props.tab === 'templates') return <TemplatesPanel templates={props.templates} onUseTemplate={props.onUseTemplate} />
  if (props.tab === 'marketplace') return <ToolsPanel tools={props.tools} onInstallPlugin={props.onInstallPlugin} />
  if (props.tab === 'credentials') return <CredentialsPanel credentials={props.credentials} onCreateCredential={props.onCreateCredential} />
  if (props.tab === 'runs') return (
    <RunsPanel
      runs={props.runs}
      usage={props.usage}
      runNodes={props.runNodes}
      activeRunId={props.activeRunId}
      deadLetters={props.deadLetters}
      onOpenRun={props.onOpenRun}
      onRefreshPlatform={props.onRefreshPlatform}
      onApproveNode={props.onApproveNode}
      onSubmitHumanForm={props.onSubmitHumanForm}
      onReplayNode={props.onReplayNode}
      onCancelActiveRun={props.onCancelActiveRun}
      onReplayDeadLetter={props.onReplayDeadLetter}
      onResolveDeadLetter={props.onResolveDeadLetter}
    />
  )
  return (
    <PanelChrome title={t('rightPanel.reasoning.title') as string} description={t('rightPanel.reasoning.description') as string} icon={<Activity size={18} />}>
      <ReasoningPanel events={props.events} eventsHasMore={props.eventsHasMore} onLoadOlderEvents={props.onLoadOlderEvents} />
    </PanelChrome>
  )
}

function PanelChrome({
  title,
  children,
  kicker,
  description,
  icon,
}: {
  title: string
  children: React.ReactNode
  kicker?: string
  description?: string
  icon?: React.ReactNode
}) {
  const { t } = useT()
  const resolvedKicker = kicker ?? (t('rightPanel.chrome.kicker') as string)
  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{resolvedKicker}</div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {icon && <span className="panel-heading-icon">{icon}</span>}
      </div>
      {children}
    </div>
  )
}

function InspectorPanel({
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
}: Pick<RightPanelProps, 'selectedNode' | 'selectedEdge' | 'runNodes' | 'validationIssues' | 'tools' | 'currentWorkflowInputs' | 'currentWorkflowOutputs' | 'onUpdateNodeConfig' | 'onUpdateNodeType' | 'onUpdateEdgeCondition'>) {
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
          <span className="status-pill" data-status={status}>{formatStatusLabel(status)}</span>
        </div>

        <div className="inspector-meta">
          <span>{t('rightPanel.inspector.stepIdLabel', { id: selectedNode.id })}</span>
          <span>{nodeIssues.length ? t('rightPanel.inspector.issueCount', { count: nodeIssues.length }) : t('rightPanel.inspector.noIssues')}</span>
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

function fieldId(scope: string, label: string) {
  return `${scope}-${label.toLowerCase().replaceAll(' ', '-')}`
}

/**
 * Per-node AI usage footer. Renders only when the selected
 * `RunNode.stateJson.output` carries a usage object — i.e. the executor
 * actually ran an LLM call (the `ai` node). Reads provider/model/tokens/cost/latency
 * from the persisted output wrapper; falls back gracefully when individual
 * fields are missing.
 *
 * Exported (rather than file-private) so the focused jsdom test can mount it
 * without spinning up the whole RightPanel.
 */
export function AiUsageFooter({ stateJson }: { stateJson?: JsonObject | null }) {
  if (!stateJson || typeof stateJson !== 'object') return null
  const state = stateJson as Record<string, unknown>
  const obj = state.output && typeof state.output === 'object'
    ? state.output as Record<string, unknown>
    : state
  const usage = obj.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return null
  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : null
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : null
  const model = typeof obj.model === 'string' ? obj.model : null
  const provider = typeof obj.provider === 'string' ? obj.provider : null
  const costUsd = typeof obj.costUsd === 'number' ? obj.costUsd : null
  const latencyMs = typeof obj.latencyMs === 'number' ? obj.latencyMs : null

  const tokenSummary = totalTokens != null
    ? `${totalTokens} tokens`
    : inputTokens != null || outputTokens != null
      ? `${inputTokens ?? 0}/${outputTokens ?? 0} tokens`
      : null

  return (
    <div className="inspector-meta" data-testid="ai-usage-footer">
      {model && <span>{provider ? `${model} (${provider})` : model}</span>}
      {tokenSummary && <span>{tokenSummary}</span>}
      {costUsd != null && <span>${costUsd.toFixed(6)}</span>}
      {latencyMs != null && <span>{latencyMs}ms</span>}
    </div>
  )
}

function QuickConfigEditor({
  nodeId,
  type,
  config,
  tools,
  onUpdate,
}: {
  nodeId: string
  type: string
  config: JsonObject
  tools: ToolSchema[]
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })

  if (type === 'http') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.requestUrl') as string} value={readConfigString(config, 'url')} onChange={value => patch({ url: value })} />
      </section>
    )
  }

  if (type === 'ai') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.prompt') as string} value={readConfigString(config, 'prompt')} onChange={value => patch({ prompt: value })} />
      </section>
    )
  }

  if (type === 'tool') {
    const selectedTool = readConfigString(config, 'tool')
    const matchedTool = tools.find(tool => tool.name === selectedTool) ?? null
    const showCurrentToolOption = Boolean(selectedTool) && !matchedTool
    const isUnknown = showCurrentToolOption && tools.length > 0
    const toolNameId = fieldId(nodeId, 'tool name')
    const onSelectTool = (next: string) => {
      // Switching tools clobbers the input only when it's empty — preserves
      // any edits the author already made on the previous tool's payload.
      const inputIsEmpty = !config.input || (typeof config.input === 'object' && config.input !== null && !Array.isArray(config.input) && Object.keys(config.input).length === 0)
      const newTool = tools.find(tool => tool.name === next)
      const seedInput = inputIsEmpty && newTool?.inputExample ? newTool.inputExample : config.input
      patch({ tool: next, input: seedInput })
    }
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <div className="form-grid">
          <label className="field-label" htmlFor={toolNameId}>{t('rightPanel.quickConfig.tool')}</label>
          <select
            id={toolNameId}
            className="text-field"
            value={selectedTool}
            onChange={event => onSelectTool(event.target.value)}
          >
            {!selectedTool && <option value="">{t('rightPanel.quickConfig.pickTool')}</option>}
            {showCurrentToolOption && <option value={selectedTool}>{tools.length > 0 ? t('rightPanel.quickConfig.toolNotRegistered', { name: selectedTool }) : t('rightPanel.quickConfig.toolLoading', { name: selectedTool })}</option>}
            {tools.map(tool => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            ))}
          </select>
          {matchedTool?.description && <p className="helper-text">{matchedTool.description}</p>}
          {matchedTool?.required && matchedTool.required.length > 0 && (
            <p className="helper-text">{t('rightPanel.quickConfig.requiredInput', { required: matchedTool.required.join(', ') })}{matchedTool.optional?.length ? t('rightPanel.quickConfig.optionalSuffix', { optional: matchedTool.optional.join(', ') }) : ''}</p>
          )}
          {isUnknown && <p className="helper-text" data-testid="unknown-tool-warning">{t('rightPanel.quickConfig.unknownToolWarning')}</p>}
        </div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.toolInput') as string} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'agent' || type === 'multi_agent') {
    const plannerId = fieldId(nodeId, `${type} planner`)
    const teamModeId = fieldId(nodeId, 'team mode')
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={type === 'multi_agent' ? (t('rightPanel.quickConfig.teamGoal') as string) : (t('rightPanel.quickConfig.agentGoal') as string)} value={readConfigString(config, 'goal')} onChange={value => patch({ goal: value })} />
        <div className="config-field-row">
          <label className="field-label" htmlFor={plannerId}>{t('rightPanel.quickConfig.planner')}</label>
          <select id={plannerId} className="text-field" value={readConfigString(config, 'planner') || 'rules'} onChange={event => patch({ planner: event.target.value })}>
            <option value="rules">{t('rightPanel.quickConfig.plannerRules')}</option>
            <option value="openai">{t('rightPanel.quickConfig.plannerOpenai')}</option>
          </select>
        </div>
        {type === 'multi_agent' && (
          <div className="config-field-row">
            <label className="field-label" htmlFor={teamModeId}>{t('rightPanel.quickConfig.teamMode')}</label>
            <select id={teamModeId} className="text-field" value={readConfigString(config, 'mode') || 'sequential'} onChange={event => patch({ mode: event.target.value })}>
              <option value="sequential">{t('rightPanel.quickConfig.teamModeSequential')}</option>
              <option value="parallel">{t('rightPanel.quickConfig.teamModeParallel')}</option>
            </select>
          </div>
        )}
        {type === 'agent' && <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.inputValue') as string} value={readConfigString(config, 'value')} onChange={value => patch({ value })} />}
        <NumberConfigField scope={nodeId} label={t('rightPanel.quickConfig.maxSteps') as string} value={readConfigNumber(config, 'maxSteps') ?? 3} onChange={value => patch({ maxSteps: value })} />
        {type === 'multi_agent' && (
          <label className="checkbox-row">
            <input type="checkbox" checked={config.reflection !== false} onChange={event => patch({ reflection: event.target.checked })} />
            <span>{t('rightPanel.quickConfig.reflection')}</span>
          </label>
        )}
      </section>
    )
  }

  if (type === 'approval') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.approvalMessage') as string} value={readConfigString(config, 'message')} onChange={value => patch({ message: value })} />
      </section>
    )
  }

  if (type === 'human_form') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.formTitle') as string} value={readConfigString(config, 'title')} onChange={value => patch({ title: value })} />
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.formInstructions') as string} value={readConfigString(config, 'description')} onChange={value => patch({ description: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldsSchema') as string} value={asJsonObject(config.schema)} onChange={value => patch({ schema: value })} />
        <p className="helper-text">{t('rightPanel.quickConfig.humanFormHelper')}</p>
      </section>
    )
  }

  if (type === 'condition') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.branchExpression') as string} value={readConfigString(config, 'expression')} onChange={value => patch({ expression: value })} />
      </section>
    )
  }

  if (type === 'subworkflow') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.workflowId') as string} value={readConfigString(config, 'workflowId')} onChange={value => patch({ workflowId: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.overrideInput') as string} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'wait_until') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.duration') as string} value={readConfigString(config, 'duration')} onChange={value => patch({ duration: value })} />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.durationHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'loop') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.items') as string} value={readConfigString(config, 'items')} onChange={value => patch({ items: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.itemMapping') as string} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'transform') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldMapping') as string} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'router' || type === 'router_llm') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.candidates') as string} value={Array.isArray(config.candidates) ? config.candidates : []} onChange={value => patch({ candidates: value })} />
      </section>
    )
  }

  if (type === 'parallel_fork') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.branches') as string}
          value={Array.isArray(config.branches) ? config.branches : []}
          onChange={value => patch({ branches: value })}
        />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.branchesHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'join') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.branchSources') as string}
          value={asJsonObject(config.sources)}
          onChange={value => patch({ sources: value })}
        />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.branchSourcesHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'mcp_tool') {
    return (
      <McpToolConfigField
        scope={nodeId}
        config={config}
        onPatch={(next) => patch(next)}
      />
    )
  }

  if (type === 'schedule') {
    const enabled = config.enabled !== false
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.cronExpression') as string}
          value={readConfigString(config, 'cronExpression')}
          onChange={value => patch({ cronExpression: value })}
        />
        <div className="config-field-row">
          <label className="field-label" htmlFor={fieldId(nodeId, 'Enabled')}>{t('rightPanel.quickConfig.scheduleEnabled')}</label>
          <input
            id={fieldId(nodeId, 'Enabled')}
            type="checkbox"
            checked={enabled}
            onChange={event => patch({ enabled: event.target.checked })}
          />
        </div>
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.scheduleHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  return (
    <section className="quick-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <p className="empty-state">{t('rightPanel.quickConfig.noSetup')}</p>
    </section>
  )
}

/**
 * Inspector branch for the `mcp_tool` node type. Fetches the org's
 * MCP connections + tools from the API on mount and renders a
 * dependent-dropdown pair (connection → tool) plus an input JSON
 * editor and an optional timeout.
 *
 * Only `active` connections appear in the dropdown; only `enabled`
 * tools appear in the per-connection list. If the saved
 * `connectionAlias` / `toolName` no longer resolve (e.g. the admin
 * disabled the tool), the inspector surfaces a "not available"
 * warning so the author knows the run will fail.
 */
function McpToolConfigField({ scope, config, onPatch }: { scope: string; config: JsonObject; onPatch: (next: Record<string, unknown>) => void }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [toolsByAlias, setToolsByAlias] = useState<Record<string, McpToolDescriptor[]>>({})
  const [loading, setLoading] = useState(true)
  const selectedAlias = readConfigString(config, 'connectionAlias')
  const selectedTool = readConfigString(config, 'toolName')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api('/mcp/connections')
      .then((data) => {
        if (cancelled) return
        const rows = (data as { connections?: McpConnection[] })?.connections ?? []
        setConnections(rows.filter((row) => row.status === 'active'))
      })
      .catch(() => {
        // Keep silent — viewer-without-permission shouldn't crash the inspector
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Re-fetch when an admin enables / disables / re-discovers a connection in
    // the Operations panel (they bump platformVersion); otherwise the dropdown
    // shows stale options until the page reloads.
  }, [platformVersion])

  useEffect(() => {
    if (!selectedAlias) return
    let cancelled = false
    // Re-fetch the per-connection tool list whenever the alias changes OR
    // platformVersion bumps (admin re-discovered / disabled a tool). The
    // previous cache-only guard kept stale descriptors after a disable.
    api(`/mcp/connections/${encodeURIComponent(selectedAlias)}/tools`)
      .then((data) => {
        if (cancelled) return
        const tools = (data as { tools?: McpToolDescriptor[] })?.tools ?? []
        setToolsByAlias((prev) => ({ ...prev, [selectedAlias]: tools.filter((t) => t.enabled) }))
      })
      .catch(() => {
        // ignore
      })
    return () => {
      cancelled = true
    }
  }, [selectedAlias, platformVersion])

  const aliasFieldId = fieldId(scope, 'mcp connection')
  const toolFieldId = fieldId(scope, 'mcp tool')
  const tools = selectedAlias ? toolsByAlias[selectedAlias] ?? [] : []
  const knownAlias = connections.some((c) => c.alias === selectedAlias)
  const knownTool = tools.some((t) => t.name === selectedTool)

  return (
    <section className="quick-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <div className="form-grid">
        <label className="field-label" htmlFor={aliasFieldId}>{t('rightPanel.mcpInspector.connection')}</label>
        <select
          id={aliasFieldId}
          className="text-field"
          value={selectedAlias}
          onChange={(event) => onPatch({ connectionAlias: event.target.value, toolName: '' })}
        >
          {!selectedAlias && <option value="">{t('rightPanel.mcpInspector.pickConnection')}</option>}
          {selectedAlias && !knownAlias && <option value={selectedAlias}>{t('rightPanel.mcpInspector.notActiveSuffix', { alias: selectedAlias })}</option>}
          {connections.map((connection) => (
            <option key={connection.id} value={connection.alias}>{t('rightPanel.mcpInspector.connectionOption', { alias: connection.alias, transport: connection.transport })}</option>
          ))}
        </select>
        {!loading && connections.length === 0 && (
          <p className="helper-text">{t('rightPanel.mcpInspector.noActiveConnections')}</p>
        )}
      </div>
      <div className="form-grid">
        <label className="field-label" htmlFor={toolFieldId}>{t('rightPanel.mcpInspector.tool')}</label>
        <select
          id={toolFieldId}
          className="text-field"
          value={selectedTool}
          onChange={(event) => onPatch({ toolName: event.target.value })}
          disabled={!selectedAlias}
        >
          {!selectedTool && <option value="">{t('rightPanel.mcpInspector.pickTool')}</option>}
          {selectedTool && !knownTool && <option value={selectedTool}>{t('rightPanel.mcpInspector.notEnabledSuffix', { name: selectedTool })}</option>}
          {tools.map((tool) => (
            <option key={tool.id} value={tool.name}>
              {tool.writeSide
                ? t('rightPanel.mcpInspector.toolWriteSideOption', { name: tool.name })
                : tool.name}
            </option>
          ))}
        </select>
        {selectedAlias && tools.length === 0 && !loading && (
          <p className="helper-text">{t('rightPanel.mcpInspector.noEnabledTools')}</p>
        )}
      </div>
      <JsonConfigField scope={scope} label={t('rightPanel.mcpInspector.toolInput') as string} value={asJsonObject(config.input)} onChange={(value) => onPatch({ input: value })} />
      <NumberConfigField
        scope={scope}
        label={t('rightPanel.mcpInspector.timeoutMs') as string}
        value={readConfigNumber(config, 'timeoutMs') ?? 30000}
        onChange={(value) => onPatch({ timeoutMs: value })}
      />
      <p className="helper-text">{t('rightPanel.mcpInspector.timeoutHelper')}</p>
    </section>
  )
}

function TextConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: string; onChange: (value: string) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="text-field" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  )
}

function NumberConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: number; onChange: (value: number) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="text-field" type="number" min={1} value={value} onChange={event => onChange(Number(event.target.value) || 1)} />
    </div>
  )
}

function TextareaConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: string; onChange: (value: string) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="code-field code-field-short" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  )
}

function JsonConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: unknown; onChange: (value: unknown) => void }) {
  const { t } = useT()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const id = fieldId(scope, label)

  useEffect(() => {
    const next = JSON.stringify(value ?? {}, null, 2)
    setDraft((current) => {
      try {
        return JSON.stringify(JSON.parse(current)) === JSON.stringify(value ?? {}) ? current : next
      } catch {
        return next
      }
    })
  }, [value])

  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="code-field code-field-short"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          try {
            onChange(JSON.parse(event.target.value))
            setError(null)
          } catch (jsonError) {
            setError(jsonError instanceof Error ? jsonError.message : (t('rightPanel.jsonField.invalidJson') as string))
          }
        }}
      />
      {error && <div className="issue issue-error">{error}</div>}
    </div>
  )
}

function readConfigString(config: JsonObject, key: string) {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function readConfigNumber(config: JsonObject, key: string) {
  const value = config[key]
  return typeof value === 'number' ? value : null
}

function asJsonObject(value: unknown) {
  return value && typeof value === 'object' ? value : {}
}

function TemplatesPanel({ templates, onUseTemplate }: Pick<RightPanelProps, 'templates' | 'onUseTemplate'>) {
  const { t } = useT()
  return (
    <PanelChrome title={t('rightPanel.templates.title') as string} description={t('rightPanel.templates.description') as string} icon={<Workflow size={18} />}>
      <div className="panel-list">
        {templates.length === 0 && <EmptyView icon={<Workflow size={22} />} title={t('rightPanel.templates.empty.title') as string} body={t('rightPanel.templates.empty.body') as string} />}
        {templates.map(template => (
          <button key={template.id} className="list-card list-card-button" onClick={() => onUseTemplate(template.workflow)}>
            <div className="split-row" style={{ width: '100%' }}>
              <span className="section-kicker">{tTemplateCategory(template)}</span>
              <span className="mode-pill mode-pill-neutral">{t('rightPanel.templates.stepCount', { count: template.workflow.nodes.length })}</span>
            </div>
            <strong>{tTemplateName(template)}</strong>
            <span>{tTemplateDescription(template)}</span>
            <span className="list-card-action">{t('rightPanel.templates.useRecipe')}</span>
          </button>
        ))}
      </div>
    </PanelChrome>
  )
}

function ToolsPanel({ tools, onInstallPlugin }: Pick<RightPanelProps, 'tools' | 'onInstallPlugin'>) {
  const { t } = useT()
  return (
    <PanelChrome title={t('rightPanel.tools.title') as string} description={t('rightPanel.tools.description') as string} icon={<Boxes size={18} />}>
      <div className="panel-list">
        {tools.length === 0 && <EmptyView icon={<Plug size={22} />} title={t('rightPanel.tools.empty.title') as string} body={t('rightPanel.tools.empty.body') as string} />}
        {tools.map(tool => (
          <div key={tool.name} className="list-card">
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{tool.name}</strong>
              <span className="mode-pill mode-pill-neutral">{t('rightPanel.tools.requiredCount', { count: tool.required?.length ?? 0 })}</span>
            </div>
            <span>{tToolDescription(tool)}</span>
            {(tool.required?.length || tool.optional?.length) && (
              <div className="mini-grid mini-grid-tight">
                {(tool.required ?? []).map(field => <span key={`required-${field}`}>{t('rightPanel.tools.requiredField', { field })}</span>)}
                {(tool.optional ?? []).map(field => <span key={`optional-${field}`}>{t('rightPanel.tools.optionalField', { field })}</span>)}
              </div>
            )}
            <button className="small-command" onClick={() => onInstallPlugin(tool.name)}>{t('rightPanel.tools.installTool')}</button>
          </div>
        ))}
      </div>
    </PanelChrome>
  )
}

function CredentialsPanel({ credentials, onCreateCredential }: Pick<RightPanelProps, 'credentials' | 'onCreateCredential'>) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [secretRef, setSecretRef] = useState('')

  return (
    <PanelChrome title={t('rightPanel.credentials.title') as string} description={t('rightPanel.credentials.description') as string} icon={<KeyRound size={18} />}>
      <section className="panel-card connection-form">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('rightPanel.credentials.formKicker')}</div>
            <strong>{t('rightPanel.credentials.formTitle')}</strong>
          </div>
          <LockKeyhole size={18} aria-hidden="true" />
        </div>
        <label className="field-label" htmlFor="credential-name">{t('rightPanel.credentials.nameLabel')}</label>
        <input id="credential-name" className="text-field" value={name} onChange={event => setName(event.target.value)} />
        <label className="field-label" htmlFor="credential-kind">{t('rightPanel.credentials.kindLabel')}</label>
        <input id="credential-kind" className="text-field" value={kind} onChange={event => setKind(event.target.value)} />
        <label className="field-label" htmlFor="credential-secret">{t('rightPanel.credentials.envLabel')}</label>
        <input id="credential-secret" className="text-field" value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder={t('rightPanel.credentials.envPlaceholder') as string} />
        <div className="form-actions connection-form-actions">
          <button
            className="command-button command-button-primary"
            onClick={() => {
              onCreateCredential({ name: name || 'API Key', kind, secretRef: secretRef || 'MY_SECRET' })
              setName('')
              setSecretRef('')
            }}
          >
            {t('rightPanel.credentials.addButton')}
          </button>
        </div>
      </section>
      <div className="panel-list">
        {credentials.length === 0 && <EmptyView icon={<ShieldCheck size={22} />} title={t('rightPanel.credentials.empty.title') as string} body={t('rightPanel.credentials.empty.body') as string} />}
        {credentials.map(credential => (
          <div key={credential.id} className="list-card">
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{credential.name}</strong>
              <span className="mode-pill mode-pill-neutral">{credential.kind}</span>
            </div>
            <span>{'{{secret.' + credential.secretRef + '}}'}</span>
          </div>
        ))}
      </div>
    </PanelChrome>
  )
}

/**
 * Closed enum mirroring `USAGE_BREAKDOWN_DIMENSIONS` in
 * `packages/engine/src/billing.ts`. Hard-coded here so we don't pull
 * the engine into the web bundle. If the backend list grows, bump
 * this list at the same time and the route validator catches drift.
 */
const USAGE_BREAKDOWN_DIMENSIONS = ['provider', 'model', 'mode', 'day', 'node', 'workflow'] as const
type UsageBreakdownDimension = typeof USAGE_BREAKDOWN_DIMENSIONS[number]

const USAGE_BREAKDOWN_LABEL_KEYS: Record<UsageBreakdownDimension, string> = {
  provider: 'rightPanel.usage.dim.provider',
  model: 'rightPanel.usage.dim.model',
  mode: 'rightPanel.usage.dim.mode',
  day: 'rightPanel.usage.dim.day',
  node: 'rightPanel.usage.dim.node',
  workflow: 'rightPanel.usage.dim.workflow',
}

type UsageBreakdownBucket = {
  key: string
  provider?: string
  model?: string
  mode?: 'ai' | 'fallback'
  day?: string
  node?: string
  workflow?: string
  quantity: number
  callCount: number
  fallbackCount: number
  costUsd: number | null
  latency: { p50Ms: number | null; p95Ms: number | null; avgMs: number | null }
}

const TOP_BUCKETS = 10

/**
 * Sentinel value the one-off backfill script (`scripts/backfill-usage-
 * workflowid.ts`) writes into `metadata.workflowId` for rows that pre-
 * date the workflow-attribution plumbing AND can't be resolved via the
 * `runs → workflow_versions` join. Rendered as "Legacy" so operators
 * can distinguish "data kept for cost continuity" from genuinely-
 * unattributed `/ai/generate-workflow` rows (which keep `workflowId:
 * null` and bucket under "unknown").
 */
const LEGACY_WORKFLOW_SENTINEL = '_legacy_pre_attribution'

/** Format a numeric quantity with k/M suffix (e.g. 8000 → "8.0k"). */
function formatQuantity(value: number): string {
  if (value < 1000) return value.toString()
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Format a USD cost ("$X.XX") or em-dash for null (unknown-model pricing). */
function formatCost(value: number | null): string {
  if (value === null) return '—'
  return `$${value.toFixed(2)}`
}

/** Format a latency value in ms ("1.2s" / "320ms" / "—"). */
function formatLatency(value: number | null): string {
  if (value === null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value)}ms`
}

/** Concatenate the per-dimension values into a human-readable label. */
function bucketLabel(b: UsageBreakdownBucket, dims: UsageBreakdownDimension[]): string {
  return dims
    .map((dim) => {
      const value = dim === 'mode' ? b.mode : b[dim]
      if (value === undefined || value === null) return runtimeT('rightPanel.usage.unknown') as string
      // Legacy-data sentinel from the backfill script — render as
      // "Legacy" so operators can distinguish backfilled-pre-attribution
      // rows from genuinely-unattributed `/ai/generate-workflow` rows
      // (which keep value === undefined → "unknown").
      if (dim === 'workflow' && value === LEGACY_WORKFLOW_SENTINEL) return runtimeT('rightPanel.usage.legacy') as string
      return value
    })
    .join(' / ')
}

/**
 * Sort comparator: rows with non-null `costUsd` first (desc), then rows
 * with null cost in the order they came in (which already reflects
 * insertion order from the in-process aggregator).
 */
function sortByCostDesc(a: UsageBreakdownBucket, b: UsageBreakdownBucket): number {
  if (a.costUsd === null && b.costUsd === null) return 0
  if (a.costUsd === null) return 1
  if (b.costUsd === null) return -1
  return b.costUsd - a.costUsd
}

/**
 * Usage summary card with optional multi-axis breakdown. The flat
 * `Record<metric, quantity>` summary stays at the top for back-compat;
 * a chip strip below lets the operator toggle one or more dimensions
 * (provider / model / mode / day / node / workflow) and renders a
 * top-N bucket table sorted by costUsd desc beneath the chips. State
 * is local — the breakdown only fetches when at least one chip is active.
 */
export function UsageSummaryCard({
  usage,
  onRefreshPlatform,
}: {
  usage: Record<string, number>
  onRefreshPlatform: () => void
}) {
  const { t } = useT()
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [activeDims, setActiveDims] = useState<UsageBreakdownDimension[]>([])
  const [breakdown, setBreakdown] = useState<UsageBreakdownBucket[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const toggleDim = (dim: UsageBreakdownDimension) => {
    setActiveDims((prev) => {
      if (prev.includes(dim)) return prev.filter((d) => d !== dim)
      return [...prev, dim]
    })
    setShowAll(false)
  }

  const refreshUsage = () => {
    setRefreshNonce((value) => value + 1)
    void onRefreshPlatform()
  }

  // Fetch the breakdown whenever the dimension selection or
  // platformVersion changes. The local refresh nonce keeps the visible
  // breakdown in lockstep with the card's Refresh button, since the
  // parent refresh updates the flat summary without necessarily bumping
  // platformVersion.
  useEffect(() => {
    if (activeDims.length === 0) {
      setBreakdown(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const query = activeDims.join(',')
    void api(`/billing/usage?breakdown=${encodeURIComponent(query)}`)
      .then((data) => {
        if (cancelled) return
        const buckets = (data as { breakdown?: UsageBreakdownBucket[] }).breakdown
        setBreakdown(Array.isArray(buckets) ? buckets : [])
      })
      .catch((error) => {
        if (cancelled) return
        addToast(error instanceof Error ? error.message : (t('rightPanel.usage.breakdownLoadFailed') as string), 'error')
        setBreakdown([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDims, platformVersion, refreshNonce, addToast, t])

  const sortedBreakdown = useMemo(() => {
    if (!breakdown) return null
    return [...breakdown].sort(sortByCostDesc)
  }, [breakdown])

  const visibleBuckets = useMemo(() => {
    if (!sortedBreakdown) return []
    return showAll ? sortedBreakdown : sortedBreakdown.slice(0, TOP_BUCKETS)
  }, [sortedBreakdown, showAll])

  const hiddenCount = sortedBreakdown ? Math.max(0, sortedBreakdown.length - TOP_BUCKETS) : 0

  return (
    <section className="panel-card">
      <div className="split-row">
        <strong>{t('rightPanel.usage.title')}</strong>
        <button className="small-command" onClick={refreshUsage}>{t('rightPanel.usage.refresh')}</button>
      </div>
      {Object.keys(usage).length === 0 ? (
        <p className="empty-state">{t('rightPanel.usage.empty')}</p>
      ) : (
        <div className="mini-grid">
          {Object.entries(usage).map(([key, value]) => (
            <span key={key}><strong>{value}</strong>{key}</span>
          ))}
        </div>
      )}

      <div className="we-usage-breakdown-controls">
        <span className="section-kicker">{t('rightPanel.usage.groupBy')}</span>
        <div className="we-usage-breakdown-chips" role="group" aria-label={t('rightPanel.usage.dimensionsAria') as string}>
          {USAGE_BREAKDOWN_DIMENSIONS.map((dim) => {
            const active = activeDims.includes(dim)
            return (
              <button
                key={dim}
                type="button"
                className={`we-usage-breakdown-chip${active ? ' we-usage-breakdown-chip--active' : ''}`}
                onClick={() => toggleDim(dim)}
                aria-pressed={active}
              >
                {t(USAGE_BREAKDOWN_LABEL_KEYS[dim])}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <p className="helper-text" aria-live="polite">{t('rightPanel.usage.loading')}</p>}

      {!loading && sortedBreakdown && sortedBreakdown.length === 0 && (
        <p className="helper-text" aria-live="polite">{t('rightPanel.usage.noBuckets')}</p>
      )}

      {!loading && visibleBuckets.length > 0 && (
        <ul className="we-usage-breakdown-list" aria-label={t('rightPanel.usage.bucketsAria') as string}>
          {visibleBuckets.map((b) => (
            <li key={b.key} className="we-usage-breakdown-row">
              <span className="we-usage-breakdown-label">{bucketLabel(b, activeDims)}</span>
              <span className="we-usage-breakdown-stats">
                <span><strong>{b.callCount}</strong> {t('rightPanel.usage.calls')}</span>
                <span><strong>{formatQuantity(b.quantity)}</strong> {t('rightPanel.usage.tokens')}</span>
                <span><strong>{formatCost(b.costUsd)}</strong></span>
                <span>{t('rightPanel.usage.p95Prefix')} {formatLatency(b.latency.p95Ms)}</span>
                {b.fallbackCount > 0 && <span className="we-usage-breakdown-fallback">{t('rightPanel.usage.fallbackSuffix', { count: b.fallbackCount })}</span>}
              </span>
            </li>
          ))}
          {hiddenCount > 0 && !showAll && (
            <li className="we-usage-breakdown-more">
              <button type="button" className="small-command" onClick={() => setShowAll(true)}>
                {t('rightPanel.usage.moreCount', { count: hiddenCount })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

type HumanFormWaiting = {
  title?: string
  description?: string
  schema: WorkflowInputSchemaShape
  resumeToken: string
}

function readHumanFormWaiting(node: RunNode): HumanFormWaiting | null {
  const waiting = node.stateJson?.waiting
  if (!waiting || typeof waiting !== 'object' || Array.isArray(waiting)) return null
  const data = waiting as Record<string, unknown>
  if (data.kind !== 'human_form') return null
  if (typeof data.resumeToken !== 'string' || !data.resumeToken) return null
  if (!isWorkflowInputSchemaShape(data.schema)) return null
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    schema: data.schema,
    resumeToken: data.resumeToken,
  }
}

function isWorkflowInputSchemaShape(value: unknown): value is WorkflowInputSchemaShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const schema = value as Record<string, unknown>
  if (!['string', 'number', 'boolean', 'object', 'array'].includes(String(schema.type))) return false
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false
    for (const child of Object.values(schema.properties as Record<string, unknown>)) {
      if (!isWorkflowInputSchemaShape(child)) return false
    }
  }
  if (schema.items !== undefined && !isWorkflowInputSchemaShape(schema.items)) return false
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(item => typeof item === 'string'))) return false
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false
  return true
}

function RunsPanel({
  runs,
  usage,
  runNodes,
  activeRunId,
  deadLetters,
  onOpenRun,
  onRefreshPlatform,
  onApproveNode,
  onSubmitHumanForm,
  onReplayNode,
  onCancelActiveRun,
  onReplayDeadLetter,
  onResolveDeadLetter,
}: Pick<RightPanelProps, 'runs' | 'usage' | 'runNodes' | 'activeRunId' | 'deadLetters' | 'onOpenRun' | 'onRefreshPlatform' | 'onApproveNode' | 'onSubmitHumanForm' | 'onReplayNode' | 'onCancelActiveRun' | 'onReplayDeadLetter' | 'onResolveDeadLetter'>) {
  const { t } = useT()
  const waitingNodes = runNodes.filter(node => node.status === 'waiting')
  const failedNodes = runNodes.filter(node => node.status === 'failed')
  const completedRuns = runs.filter(run => run.status === 'succeeded').length
  const activeRuns = runs.filter(run => run.status === 'running' || run.status === 'queued').length
  const failedRuns = runs.filter(run => run.status === 'failed').length
  const [activeHumanFormNodeId, setActiveHumanFormNodeId] = useState<string | null>(null)
  const [humanFormErrors, setHumanFormErrors] = useState<string[]>([])
  const [humanFormSubmitting, setHumanFormSubmitting] = useState(false)
  const addToast = useWorkflowStore(state => state.addToast)
  // Replay Lab source — set when the operator clicks "Open in Lab" from
  // the active-run card or a history row. The dialog mounts overlay-style
  // while non-null and the source run id stays around as state until the
  // operator dismisses the dialog.
  const [labSourceRun, setLabSourceRun] = useState<RunSummary | null>(null)
  // Replay Lab Fork target node id — set when the operator clicks a
  // per-node "Fork at <nodeId>" button. The dialog mounts overlay-style
  // against the active run; on success it switches the active run id
  // to the new fork run and unmounts.
  const [forkTargetNodeId, setForkTargetNodeId] = useState<string | null>(null)
  // Report-delivery source — set when the operator clicks "Send" next
  // to the Export action. Dialog mounts overlay-style while non-null.
  const [deliveryRun, setDeliveryRun] = useState<RunSummary | null>(null)
  const activeHumanFormNode = activeHumanFormNodeId
    ? waitingNodes.find(node => node.nodeId === activeHumanFormNodeId) ?? null
    : null
  const activeHumanForm = activeHumanFormNode ? readHumanFormWaiting(activeHumanFormNode) : null

  // Cancellable when the active run is in a non-terminal status.
  const activeRun = activeRunId ? runs.find(run => run.id === activeRunId) : null
  const isActiveRunCancellable = Boolean(
    activeRunId && onCancelActiveRun && (!activeRun || !isTerminalRunStatus(activeRun.status)),
  )

  // Fork-eligible nodes: only terminal node states (succeeded / failed)
  // are forkable, and only when the source run itself is terminal and
  // NOT already a sandbox replay. The server enforces both invariants
  // too — this UI gate just hides the action so the operator doesn't
  // click into a guaranteed 4xx.
  const forkableNodes = (activeRun && !activeRun.replayMode && isTerminalRunStatus(activeRun.status))
    ? runNodes.filter(node => node.status === 'succeeded' || node.status === 'failed')
    : []

  return (
    <PanelChrome title={t('rightPanel.runs.title') as string} description={t('rightPanel.runs.description') as string} icon={<Activity size={18} />}>
      <section className="metric-strip" aria-label={t('rightPanel.runs.summaryAria') as string}>
        <Metric label={t('rightPanel.runs.metric.total') as string} value={runs.length} icon={<ListChecks size={15} />} />
        <Metric label={t('rightPanel.runs.metric.active') as string} value={activeRuns} icon={<Activity size={15} />} />
        <Metric label={t('rightPanel.runs.metric.done') as string} value={completedRuns} icon={<CheckCircle2 size={15} />} />
        <Metric label={t('rightPanel.runs.metric.failed') as string} value={failedRuns} icon={<RefreshCw size={15} />} />
      </section>

      {activeRunId && (
        <section className="panel-card">
          <div className="split-row">
            <strong>{t('rightPanel.runs.activeRun')}</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              {activeRun && !activeRun.replayMode && isTerminalRunStatus(activeRun.status) && (
                <button
                  type="button"
                  className="small-command"
                  onClick={() => setLabSourceRun(activeRun)}
                  data-testid="active-run-replay-in-lab"
                >
                  <FlaskConical size={12} aria-hidden="true" /> {t('rightPanel.runs.openInLab')}
                </button>
              )}
              <button
                type="button"
                className="small-command"
                onClick={() => onCancelActiveRun?.()}
                disabled={!isActiveRunCancellable}
              >
                {t('rightPanel.runs.cancelRun')}
              </button>
            </div>
          </div>
          <p className="helper-text">
            {activeRun
              ? (isActiveRunCancellable
                ? t('rightPanel.runs.activeRunStatusCancellable', { status: activeRun.status })
                : t('rightPanel.runs.activeRunStatusFinished', { status: activeRun.status }))
              : t('rightPanel.runs.activeRunLoading')}
          </p>
          {activeRun?.status === 'succeeded' && activeRun.outputJson && Object.keys(activeRun.outputJson).length > 0 && (
            <details data-testid="workflow-output" style={{ marginTop: 12 }}>
              <summary>{t('rightPanel.runs.workflowOutput')}</summary>
              <pre className="code-field" style={{ marginTop: 8, padding: 8 }}>
                {JSON.stringify(activeRun.outputJson, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}

      <UsageSummaryCard usage={usage} onRefreshPlatform={onRefreshPlatform} />

      {waitingNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('rightPanel.runs.pausedTitle')}</strong>
            <p className="helper-text">{t('rightPanel.runs.pausedDescription')}</p>
          </div>
          {waitingNodes.map(node => {
            const form = readHumanFormWaiting(node)
            if (form) {
              return (
                <button
                  key={node.nodeId}
                  className="small-command small-command--primary"
                  onClick={() => {
                    setHumanFormErrors([])
                    setActiveHumanFormNodeId(node.nodeId)
                  }}
                >
                  {t('rightPanel.runs.fillForm', { nodeId: node.nodeId })}
                </button>
              )
            }
            return (
              <button key={node.nodeId} className="small-command" onClick={() => onApproveNode(node.nodeId)}>
                {t('rightPanel.runs.resume', { nodeId: node.nodeId })}
              </button>
            )
          })}
        </section>
      )}

      {activeHumanFormNode && activeHumanForm && (
        <HumanFormDialog
          title={activeHumanForm.title}
          description={activeHumanForm.description}
          schema={activeHumanForm.schema}
          serverErrors={humanFormErrors}
          submitting={humanFormSubmitting}
          onCancel={() => {
            setActiveHumanFormNodeId(null)
            setHumanFormErrors([])
          }}
          onSubmit={async (input) => {
            setHumanFormSubmitting(true)
            setHumanFormErrors([])
            try {
              const result = await onSubmitHumanForm(activeHumanFormNode.nodeId, input, activeHumanForm.resumeToken)
              if (Array.isArray(result) && result.length > 0) {
                setHumanFormErrors(result)
                return
              }
              setActiveHumanFormNodeId(null)
            } finally {
              setHumanFormSubmitting(false)
            }
          }}
        />
      )}

      {failedNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('rightPanel.runs.attentionTitle')}</strong>
            <p className="helper-text">{t('rightPanel.runs.attentionDescription')}</p>
          </div>
          {failedNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onReplayNode(node.nodeId)}>
              {t('rightPanel.runs.retry', { nodeId: node.nodeId })}
            </button>
          ))}
        </section>
      )}

      {forkableNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('replayLab.fork.sectionKicker')}</strong>
            <p className="helper-text">{t('replayLab.fork.sectionDescription')}</p>
          </div>
          {forkableNodes.map(node => (
            <button
              key={node.nodeId}
              type="button"
              className="small-command"
              onClick={() => setForkTargetNodeId(node.nodeId)}
              data-testid={`fork-in-lab-${node.nodeId}`}
            >
              <GitBranch size={12} aria-hidden="true" />
              {' '}
              {node.status === 'succeeded'
                ? t('replayLab.fork.buttonStatusSucceeded', { nodeId: node.nodeId })
                : t('replayLab.fork.buttonStatusFailed', { nodeId: node.nodeId })}
            </button>
          ))}
        </section>
      )}

      <RunExplainChat runId={activeRunId} />

      <DeadLettersPanel
        deadLetters={deadLetters}
        onRefresh={onRefreshPlatform}
        onReplay={onReplayDeadLetter}
        onResolve={onResolveDeadLetter}
      />

      <div className="panel-list">
        <div className="section-kicker">{t('rightPanel.runs.historyKicker')}</div>
        {runs.length === 0 && <EmptyView icon={<Activity size={22} />} title={t('rightPanel.runs.historyEmpty.title') as string} body={t('rightPanel.runs.historyEmpty.body') as string} />}
        {runs.map(run => {
          const showLabAction = !run.replayMode && isTerminalRunStatus(run.status)
          return (
            <div key={run.id} className="list-card we-run-history-card" role="group">
              <button type="button" className="list-card-row" onClick={() => onOpenRun(run.id)}>
                <div className="split-row" style={{ width: '100%' }}>
                  <strong>{run.id.slice(0, 8)}…</strong>
                  <span className="status-pill" data-status={run.status}>{formatStatusLabel(run.status)}</span>
                </div>
                <span>{run.createdAt ? new Date(run.createdAt).toLocaleString(getResolvedLocale()) : (t('rightPanel.runs.runFallback') as string)}</span>
                <span className="list-card-action">{t('rightPanel.runs.openTimeline')}</span>
              </button>
              {showLabAction && (
                <button
                  type="button"
                  className="small-command we-replay-lab-history-button"
                  onClick={() => setLabSourceRun(run)}
                  data-testid={`history-replay-in-lab-${run.id}`}
                  aria-label={t('rightPanel.runs.replayInLabAria', { id: run.id }) as string}
                >
                  <FlaskConical size={12} aria-hidden="true" /> {t('rightPanel.runs.lab')}
                </button>
              )}
              <button
                type="button"
                className="small-command we-run-history-export-button"
                onClick={async () => {
                  try {
                    await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(run.id)}`)
                    addToast(t('rightPanel.runs.exportSuccess') as string, 'success')
                  } catch (err) {
                    const message = err instanceof Error ? err.message : (t('rightPanel.runs.exportFailed') as string)
                    addToast(message, 'error')
                  }
                }}
                data-testid={`history-export-${run.id}`}
                aria-label={t('rightPanel.runs.exportAria', { id: run.id }) as string}
              >
                <Download size={12} aria-hidden="true" /> {t('rightPanel.runs.export')}
              </button>
              <button
                type="button"
                className="small-command we-run-history-send-button"
                onClick={() => setDeliveryRun(run)}
                data-testid={`history-send-${run.id}`}
                aria-label={t('rightPanel.runs.sendAria', { id: run.id }) as string}
              >
                <Send size={12} aria-hidden="true" /> {t('rightPanel.runs.send')}
              </button>
            </div>
          )
        })}
      </div>

      {labSourceRun && (
        <ReplayLabDialog
          sourceRun={{
            id: labSourceRun.id,
            status: labSourceRun.status,
            workflowVersionId: labSourceRun.workflowVersionId,
            createdAt: labSourceRun.createdAt ?? null,
          }}
          onClose={() => setLabSourceRun(null)}
        />
      )}

      {forkTargetNodeId && activeRun && (
        <ReplayLabForkDialog
          sourceRun={{
            id: activeRun.id,
            status: activeRun.status,
            createdAt: activeRun.createdAt ?? null,
          }}
          forkNodeId={forkTargetNodeId}
          onClose={() => setForkTargetNodeId(null)}
        />
      )}

      {deliveryRun && (
        <ReportDeliveryDialog
          sourceRun={{
            id: deliveryRun.id,
            status: deliveryRun.status,
          }}
          onClose={() => setDeliveryRun(null)}
        />
      )}
    </PanelChrome>
  )
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="metric-item">
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  )
}

function EmptyView({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="empty-panel">
      {icon}
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function ReasoningPanel({
  events,
  eventsHasMore,
  onLoadOlderEvents,
}: {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
}) {
  const { t } = useT()
  const visibleEvents = useMemo(() => [...events].reverse(), [events])

  return (
    <div className="panel-list">
      {visibleEvents.length === 0 && <EmptyView icon={<Activity size={22} />} title={t('rightPanel.reasoning.empty.title') as string} body={t('rightPanel.reasoning.empty.body') as string} />}
      {visibleEvents.map(event => (
        <div key={event.id ?? `${event.type}:${event.nodeId ?? ''}:${event.createdAt ?? ''}`} className="list-card">
          <strong>{event.type}</strong>
          <span>{event.nodeId ?? (t('rightPanel.reasoning.runLabel') as string)}</span>
          <pre className="mini-pre">{JSON.stringify(event.payload ?? {}, null, 2)}</pre>
        </div>
      ))}
      {eventsHasMore && onLoadOlderEvents && <LoadOlderEventsButton onClick={onLoadOlderEvents} />}
    </div>
  )
}

function LoadOlderEventsButton({ onClick }: { onClick: () => void | Promise<void> }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="load-older-events"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? t('rightPanel.reasoning.loading') : t('rightPanel.reasoning.loadOlder')}
    </button>
  )
}
