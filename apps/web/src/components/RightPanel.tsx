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
import { Activity, Boxes, CheckCircle2, Database, GitBranch, KeyRound, Layers3, ListChecks, LockKeyhole, Plug, RefreshCw, ShieldCheck, Users, Workflow } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, AiHealth, AiMode, Credential, JsonObject, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { MultiAgentTimeline } from '../MultiAgentTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { MembersPanel } from './MembersPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { DeadLettersPanel, type DeadLetter } from './DeadLettersPanel'
import { RunExplainChat } from './RunExplainChat'
import { AiCopilotPanel } from './AiCopilotPanel'
import { OperationsPanel } from './OperationsPanel'
import { formatStatusLabel, getNodeConfigSummary, getNodeLabel, nodeTypes } from '../constants'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { api } from '../api'
import { useWorkflowStore } from '../store'

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

/** Tab-aware right-side panel router — picks the inner panel component for the active tab. */
export function RightPanel(props: RightPanelProps) {
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
    <PanelChrome title="Multi-agent timeline" description="Follow agent and team events as a run moves through the flow." icon={<Layers3 size={18} />}>
      <MultiAgentTimeline events={props.events} eventsHasMore={props.eventsHasMore} onLoadOlderEvents={props.onLoadOlderEvents} />
    </PanelChrome>
  )
  if (props.tab === 'workflows') return (
    <PanelChrome title="Flows" description="Open saved flows and continue from the latest version." icon={<Database size={18} />}>
      <WorkflowsDashboard onOpen={props.onOpenWorkflow} />
    </PanelChrome>
  )
  if (props.tab === 'operations') return <OperationsPanel />
  if (props.tab === 'members') return (
    <PanelChrome title="Team" description="Invite teammates and choose what they can operate." icon={<Users size={18} />}>
      <MembersPanel />
    </PanelChrome>
  )
  if (props.tab === 'inspector') return (
    <PanelChrome title="Step setup" description="Select a step or path on the canvas to edit how it behaves." icon={<GitBranch size={18} />}>
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
      onReplayNode={props.onReplayNode}
      onCancelActiveRun={props.onCancelActiveRun}
      onReplayDeadLetter={props.onReplayDeadLetter}
      onResolveDeadLetter={props.onResolveDeadLetter}
    />
  )
  return (
    <PanelChrome title="Run events" description="Low-level execution signals for debugging." icon={<Activity size={18} />}>
      <ReasoningPanel events={props.events} eventsHasMore={props.eventsHasMore} onLoadOlderEvents={props.onLoadOlderEvents} />
    </PanelChrome>
  )
}

function PanelChrome({
  title,
  children,
  kicker = 'Workspace',
  description,
  icon,
}: {
  title: string
  children: React.ReactNode
  kicker?: string
  description?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{kicker}</div>
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
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nodeStatus = selectedNode ? runNodes.find(node => node.nodeId === selectedNode.id) : null
  const nodeIssues = selectedNode ? validationIssues.filter(issue => issue.nodeId === selectedNode.id) : []

  if (selectedNode) {
    const status = nodeStatus?.status ?? 'draft'

    return (
      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">Step</div>
            <h3>{getNodeLabel(selectedNode.data.type)}</h3>
            <p className="helper-text">{getNodeConfigSummary(selectedNode.data.type, selectedNode.data.config ?? {})}</p>
          </div>
          <span className="status-pill" data-status={status}>{formatStatusLabel(status)}</span>
        </div>

        <div className="inspector-meta">
          <span>Step ID {selectedNode.id}</span>
          <span>{nodeIssues.length ? `${nodeIssues.length} issue${nodeIssues.length === 1 ? '' : 's'}` : 'No validation issues'}</span>
        </div>

        <AiUsageFooter stateJson={nodeStatus?.stateJson} />


        <div className="form-grid">
          <label className="field-label" htmlFor="node-type">Step kind</label>
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
          <summary>Advanced JSON</summary>
          <p className="helper-text">Use this when you need to edit the exact payload sent to the engine.</p>
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
                setJsonError(error instanceof Error ? error.message : 'Settings must be valid JSON')
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
        <div className="section-kicker">Path</div>
        <h3>{selectedEdge.source} to {selectedEdge.target}</h3>
        <label className="field-label" htmlFor="edge-condition">Run only when</label>
        <textarea
          id="edge-condition"
          className="code-field code-field-short"
          defaultValue={selectedEdge.data?.condition ?? ''}
          onBlur={(event) => onUpdateEdgeCondition(selectedEdge.id, event.target.value.trim())}
          placeholder="context.http.output.statusCode === 200"
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
          <strong>Select a step to configure it</strong>
          <p>Click any node on the canvas to edit inputs, prompts, tools, path rules, and advanced JSON.</p>
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
  return (
    <section className="panel-card" data-testid="workflow-io-card">
      <div className="section-kicker">Workflow I/O</div>
      <h3>Declared inputs &amp; outputs</h3>
      <p className="helper-text">Surface contract for callers and subworkflow consumers. Inputs validate at run start; outputs project at terminal status.</p>

      {inputs && (
        <div className="form-grid">
          <div className="field-label">Inputs</div>
          <ul className="inspector-meta" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {renderInputFields(inputs).map((row, idx) => (
              <li key={`${row.path}-${idx}`}>
                <span>{row.path}</span>
                <span>{row.type}{row.required ? ' (required)' : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outputs && Object.keys(outputs).length > 0 && (
        <div className="form-grid">
          <div className="field-label">Outputs</div>
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
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })

  if (type === 'http') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextConfigField scope={nodeId} label="Request URL" value={readConfigString(config, 'url')} onChange={value => patch({ url: value })} />
      </section>
    )
  }

  if (type === 'ai') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextareaConfigField scope={nodeId} label="Prompt" value={readConfigString(config, 'prompt')} onChange={value => patch({ prompt: value })} />
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
        <div className="section-kicker">Quick setup</div>
        <div className="form-grid">
          <label className="field-label" htmlFor={toolNameId}>Tool</label>
          <select
            id={toolNameId}
            className="text-field"
            value={selectedTool}
            onChange={event => onSelectTool(event.target.value)}
          >
            {!selectedTool && <option value="">— Pick a tool —</option>}
            {showCurrentToolOption && <option value={selectedTool}>{selectedTool}{tools.length > 0 ? ' (not registered)' : ' (loading)'}</option>}
            {tools.map(tool => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            ))}
          </select>
          {matchedTool?.description && <p className="helper-text">{matchedTool.description}</p>}
          {matchedTool?.required && matchedTool.required.length > 0 && (
            <p className="helper-text">Required input: {matchedTool.required.join(', ')}{matchedTool.optional?.length ? ` · Optional: ${matchedTool.optional.join(', ')}` : ''}</p>
          )}
          {isUnknown && <p className="helper-text" data-testid="unknown-tool-warning">This tool is not registered — pick one from the list.</p>}
        </div>
        <JsonConfigField scope={nodeId} label="Tool input" value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'agent' || type === 'multi_agent') {
    const plannerId = fieldId(nodeId, `${type} planner`)
    const teamModeId = fieldId(nodeId, 'team mode')
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextareaConfigField scope={nodeId} label={type === 'multi_agent' ? 'Team goal' : 'Agent goal'} value={readConfigString(config, 'goal')} onChange={value => patch({ goal: value })} />
        <div className="config-field-row">
          <label className="field-label" htmlFor={plannerId}>Planner</label>
          <select id={plannerId} className="text-field" value={readConfigString(config, 'planner') || 'rules'} onChange={event => patch({ planner: event.target.value })}>
            <option value="rules">Rules</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        {type === 'multi_agent' && (
          <div className="config-field-row">
            <label className="field-label" htmlFor={teamModeId}>Team mode</label>
            <select id={teamModeId} className="text-field" value={readConfigString(config, 'mode') || 'sequential'} onChange={event => patch({ mode: event.target.value })}>
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
          </div>
        )}
        {type === 'agent' && <TextConfigField scope={nodeId} label="Input value" value={readConfigString(config, 'value')} onChange={value => patch({ value })} />}
        <NumberConfigField scope={nodeId} label="Max steps" value={readConfigNumber(config, 'maxSteps') ?? 3} onChange={value => patch({ maxSteps: value })} />
        {type === 'multi_agent' && (
          <label className="checkbox-row">
            <input type="checkbox" checked={config.reflection !== false} onChange={event => patch({ reflection: event.target.checked })} />
            <span>Review results before completing</span>
          </label>
        )}
      </section>
    )
  }

  if (type === 'approval') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextareaConfigField scope={nodeId} label="Approval message" value={readConfigString(config, 'message')} onChange={value => patch({ message: value })} />
      </section>
    )
  }

  if (type === 'condition') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextareaConfigField scope={nodeId} label="Branch expression" value={readConfigString(config, 'expression')} onChange={value => patch({ expression: value })} />
      </section>
    )
  }

  if (type === 'subworkflow') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextConfigField scope={nodeId} label="Workflow id" value={readConfigString(config, 'workflowId')} onChange={value => patch({ workflowId: value })} />
        <JsonConfigField scope={nodeId} label="Override input (optional)" value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'wait_until') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextConfigField scope={nodeId} label="Duration (ISO 8601)" value={readConfigString(config, 'duration')} onChange={value => patch({ duration: value })} />
        <p className="helper-text">Examples: <code>PT5M</code> (5 min), <code>PT2H</code> (2 hours), <code>P3D</code> (3 days), <code>P1Y</code> (1 year ≈ 365 days). Manual resume short-circuits the wait.</p>
      </section>
    )
  }

  if (type === 'loop') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextConfigField scope={nodeId} label="Items" value={readConfigString(config, 'items')} onChange={value => patch({ items: value })} />
        <JsonConfigField scope={nodeId} label="Item mapping" value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'transform') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <JsonConfigField scope={nodeId} label="Field mapping" value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'router' || type === 'router_llm') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <JsonConfigField scope={nodeId} label="Candidate paths" value={Array.isArray(config.candidates) ? config.candidates : []} onChange={value => patch({ candidates: value })} />
      </section>
    )
  }

  if (type === 'parallel_fork') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <JsonConfigField
          scope={nodeId}
          label="Branches"
          value={Array.isArray(config.branches) ? config.branches : []}
          onChange={value => patch({ branches: value })}
        />
        <p className="helper-text">2-10 entries. Each branch is <code>{'{ "label": "name", "description"?: "what it computes" }'}</code>. Wire one outgoing edge per branch in the canvas; the matching <code>join</code> downstream merges results by label.</p>
      </section>
    )
  }

  if (type === 'join') {
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <JsonConfigField
          scope={nodeId}
          label="Branch sources"
          value={asJsonObject(config.sources)}
          onChange={value => patch({ sources: value })}
        />
        <p className="helper-text"><code>{'{ "<label>": "<predecessor_node_id>" }'}</code>. Output is <code>{'{ branches: { <label>: <predecessor.output> } }'}</code>. Every predecessor id must be a node that actually feeds this join.</p>
      </section>
    )
  }

  if (type === 'schedule') {
    const enabled = config.enabled !== false
    return (
      <section className="quick-config">
        <div className="section-kicker">Quick setup</div>
        <TextConfigField
          scope={nodeId}
          label="Cron expression"
          value={readConfigString(config, 'cronExpression')}
          onChange={value => patch({ cronExpression: value })}
        />
        <div className="config-field-row">
          <label className="field-label" htmlFor={fieldId(nodeId, 'Enabled')}>Enabled</label>
          <input
            id={fieldId(nodeId, 'Enabled')}
            type="checkbox"
            checked={enabled}
            onChange={event => patch({ enabled: event.target.checked })}
          />
        </div>
        <p className="helper-text">5-field cron (minute hour day-of-month month day-of-week). Examples: <code>0 9 * * *</code> (daily 9am), <code>*/5 * * * *</code> (every 5 min), <code>0 0 * * 1</code> (Mondays). Uncheck Enabled to pause without losing the schedule.</p>
      </section>
    )
  }

  return (
    <section className="quick-config">
      <div className="section-kicker">Quick setup</div>
      <p className="empty-state">This step has no required setup. Use advanced JSON only for custom behavior.</p>
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
            setError(jsonError instanceof Error ? jsonError.message : 'Value must be valid JSON')
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
  return (
    <PanelChrome title="Recipes" description="Start from a tested pattern, then adjust the steps on the canvas." icon={<Workflow size={18} />}>
      <div className="panel-list">
        {templates.length === 0 && <EmptyView icon={<Workflow size={22} />} title="No recipes loaded" body="Refresh the API connection and try again." />}
        {templates.map(template => (
          <button key={template.id} className="list-card list-card-button" onClick={() => onUseTemplate(template.workflow)}>
            <div className="split-row" style={{ width: '100%' }}>
              <span className="section-kicker">{template.category}</span>
              <span className="mode-pill mode-pill-neutral">{template.workflow.nodes.length} steps</span>
            </div>
            <strong>{template.name}</strong>
            <span>{template.description}</span>
            <span className="list-card-action">Use recipe</span>
          </button>
        ))}
      </div>
    </PanelChrome>
  )
}

function ToolsPanel({ tools, onInstallPlugin }: Pick<RightPanelProps, 'tools' | 'onInstallPlugin'>) {
  return (
    <PanelChrome title="Tools" description="Install backend actions that a flow or agent can call." icon={<Boxes size={18} />}>
      <div className="panel-list">
        {tools.length === 0 && <EmptyView icon={<Plug size={22} />} title="No tools available" body="Start the API to load registered tool actions." />}
        {tools.map(tool => (
          <div key={tool.name} className="list-card">
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{tool.name}</strong>
              <span className="mode-pill mode-pill-neutral">{tool.required?.length ?? 0} required</span>
            </div>
            <span>{tool.description}</span>
            {(tool.required?.length || tool.optional?.length) && (
              <div className="mini-grid mini-grid-tight">
                {(tool.required ?? []).map(field => <span key={`required-${field}`}>Required: {field}</span>)}
                {(tool.optional ?? []).map(field => <span key={`optional-${field}`}>Optional: {field}</span>)}
              </div>
            )}
            <button className="small-command" onClick={() => onInstallPlugin(tool.name)}>Install tool</button>
          </div>
        ))}
      </div>
    </PanelChrome>
  )
}

function CredentialsPanel({ credentials, onCreateCredential }: Pick<RightPanelProps, 'credentials' | 'onCreateCredential'>) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [secretRef, setSecretRef] = useState('')

  return (
    <PanelChrome title="Connections" description="Reference secrets by environment variable name without exposing values in the UI." icon={<KeyRound size={18} />}>
      <section className="panel-card connection-form">
        <div className="split-row">
          <div>
            <div className="section-kicker">New connection</div>
            <strong>Register a secret reference</strong>
          </div>
          <LockKeyhole size={18} aria-hidden="true" />
        </div>
        <label className="field-label" htmlFor="credential-name">Connection name</label>
        <input id="credential-name" className="text-field" value={name} onChange={event => setName(event.target.value)} />
        <label className="field-label" htmlFor="credential-kind">Connection kind</label>
        <input id="credential-kind" className="text-field" value={kind} onChange={event => setKind(event.target.value)} />
        <label className="field-label" htmlFor="credential-secret">Environment variable</label>
        <input id="credential-secret" className="text-field" value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder="SLACK_BOT_TOKEN" />
        <div className="form-actions connection-form-actions">
          <button
            className="command-button command-button-primary"
            onClick={() => {
              onCreateCredential({ name: name || 'API Key', kind, secretRef: secretRef || 'MY_SECRET' })
              setName('')
              setSecretRef('')
            }}
          >
            Add connection
          </button>
        </div>
      </section>
      <div className="panel-list">
        {credentials.length === 0 && <EmptyView icon={<ShieldCheck size={22} />} title="No connections yet" body="Create a reference once the matching environment variable exists in the runtime." />}
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

const USAGE_BREAKDOWN_LABELS: Record<UsageBreakdownDimension, string> = {
  provider: 'Provider',
  model: 'Model',
  mode: 'Mode',
  day: 'Day',
  node: 'Node',
  workflow: 'Workflow',
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
      if (value === undefined || value === null) return 'unknown'
      // Legacy-data sentinel from the backfill script — render as
      // "Legacy" so operators can distinguish backfilled-pre-attribution
      // rows from genuinely-unattributed `/ai/generate-workflow` rows
      // (which keep value === undefined → "unknown").
      if (dim === 'workflow' && value === LEGACY_WORKFLOW_SENTINEL) return 'Legacy'
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
        addToast(error instanceof Error ? error.message : 'Usage breakdown failed to load', 'error')
        setBreakdown([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDims, platformVersion, refreshNonce, addToast])

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
        <strong>Usage summary</strong>
        <button className="small-command" onClick={refreshUsage}>Refresh</button>
      </div>
      {Object.keys(usage).length === 0 ? (
        <p className="empty-state">No usage recorded yet.</p>
      ) : (
        <div className="mini-grid">
          {Object.entries(usage).map(([key, value]) => (
            <span key={key}><strong>{value}</strong>{key}</span>
          ))}
        </div>
      )}

      <div className="we-usage-breakdown-controls">
        <span className="section-kicker">Group by</span>
        <div className="we-usage-breakdown-chips" role="group" aria-label="Usage breakdown dimensions">
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
                {USAGE_BREAKDOWN_LABELS[dim]}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <p className="helper-text" aria-live="polite">Loading breakdown…</p>}

      {!loading && sortedBreakdown && sortedBreakdown.length === 0 && (
        <p className="helper-text" aria-live="polite">No buckets in this window.</p>
      )}

      {!loading && visibleBuckets.length > 0 && (
        <ul className="we-usage-breakdown-list" aria-label="Usage breakdown buckets">
          {visibleBuckets.map((b) => (
            <li key={b.key} className="we-usage-breakdown-row">
              <span className="we-usage-breakdown-label">{bucketLabel(b, activeDims)}</span>
              <span className="we-usage-breakdown-stats">
                <span><strong>{b.callCount}</strong> calls</span>
                <span><strong>{formatQuantity(b.quantity)}</strong> tokens</span>
                <span><strong>{formatCost(b.costUsd)}</strong></span>
                <span>p95 {formatLatency(b.latency.p95Ms)}</span>
                {b.fallbackCount > 0 && <span className="we-usage-breakdown-fallback">{b.fallbackCount} fallback</span>}
              </span>
            </li>
          ))}
          {hiddenCount > 0 && !showAll && (
            <li className="we-usage-breakdown-more">
              <button type="button" className="small-command" onClick={() => setShowAll(true)}>
                + {hiddenCount} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
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
  onReplayNode,
  onCancelActiveRun,
  onReplayDeadLetter,
  onResolveDeadLetter,
}: Pick<RightPanelProps, 'runs' | 'usage' | 'runNodes' | 'activeRunId' | 'deadLetters' | 'onOpenRun' | 'onRefreshPlatform' | 'onApproveNode' | 'onReplayNode' | 'onCancelActiveRun' | 'onReplayDeadLetter' | 'onResolveDeadLetter'>) {
  const waitingNodes = runNodes.filter(node => node.status === 'waiting')
  const failedNodes = runNodes.filter(node => node.status === 'failed')
  const completedRuns = runs.filter(run => run.status === 'succeeded').length
  const activeRuns = runs.filter(run => run.status === 'running' || run.status === 'queued').length
  const failedRuns = runs.filter(run => run.status === 'failed').length

  // Cancellable when the active run is in a non-terminal status.
  const activeRun = activeRunId ? runs.find(run => run.id === activeRunId) : null
  const isActiveRunCancellable = Boolean(
    activeRunId && onCancelActiveRun && (!activeRun || !isTerminalRunStatus(activeRun.status)),
  )

  return (
    <PanelChrome title="Runs" description="Review execution history, approvals, retries, and AI explanations." icon={<Activity size={18} />}>
      <section className="metric-strip" aria-label="Run summary">
        <Metric label="Total" value={runs.length} icon={<ListChecks size={15} />} />
        <Metric label="Active" value={activeRuns} icon={<Activity size={15} />} />
        <Metric label="Done" value={completedRuns} icon={<CheckCircle2 size={15} />} />
        <Metric label="Failed" value={failedRuns} icon={<RefreshCw size={15} />} />
      </section>

      {activeRunId && (
        <section className="panel-card">
          <div className="split-row">
            <strong>Active run</strong>
            <button
              type="button"
              className="small-command"
              onClick={() => onCancelActiveRun?.()}
              disabled={!isActiveRunCancellable}
            >
              Cancel run
            </button>
          </div>
          <p className="helper-text">
            {activeRun
              ? `Status: ${activeRun.status}. ${isActiveRunCancellable ? "Cancel flips it to cancelled and stops scheduling further nodes." : "Run already finished — cancel is a no-op."}`
              : "Run details are loading."}
          </p>
          {activeRun?.status === 'succeeded' && activeRun.outputJson && Object.keys(activeRun.outputJson).length > 0 && (
            <details data-testid="workflow-output" style={{ marginTop: 12 }}>
              <summary>Workflow output</summary>
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
            <strong>Needs approval</strong>
            <p className="helper-text">Resume paused approval steps from here.</p>
          </div>
          {waitingNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onApproveNode(node.nodeId)}>
              Approve {node.nodeId}
            </button>
          ))}
        </section>
      )}

      {failedNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>Needs attention</strong>
            <p className="helper-text">Retry failed steps after reviewing their payloads.</p>
          </div>
          {failedNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onReplayNode(node.nodeId)}>
              Retry {node.nodeId}
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
        <div className="section-kicker">History</div>
        {runs.length === 0 && <EmptyView icon={<Activity size={22} />} title="No runs yet" body="Press Run to execute the current flow and inspect the result here." />}
        {runs.map(run => (
          <button key={run.id} className="list-card list-card-button" onClick={() => onOpenRun(run.id)}>
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{run.id.slice(0, 8)}…</strong>
              <span className="status-pill" data-status={run.status}>{formatStatusLabel(run.status)}</span>
            </div>
            <span>{run.createdAt ? new Date(run.createdAt).toLocaleString() : 'run'}</span>
            <span className="list-card-action">Open run timeline</span>
          </button>
        ))}
      </div>
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
  const visibleEvents = useMemo(() => [...events].reverse(), [events])

  return (
    <div className="panel-list">
      {visibleEvents.length === 0 && <EmptyView icon={<Activity size={22} />} title="No run events yet" body="Run a flow to inspect low-level execution signals." />}
      {visibleEvents.map(event => (
        <div key={event.id ?? `${event.type}:${event.nodeId ?? ''}:${event.createdAt ?? ''}`} className="list-card">
          <strong>{event.type}</strong>
          <span>{event.nodeId ?? 'run'}</span>
          <pre className="mini-pre">{JSON.stringify(event.payload ?? {}, null, 2)}</pre>
        </div>
      ))}
      {eventsHasMore && onLoadOlderEvents && <LoadOlderEventsButton onClick={onLoadOlderEvents} />}
    </div>
  )
}

function LoadOlderEventsButton({ onClick }: { onClick: () => void | Promise<void> }) {
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
      {busy ? 'Loading…' : 'Load older events'}
    </button>
  )
}
