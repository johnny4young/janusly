import React, { useMemo, useState } from 'react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { CrewTimeline } from '../CrewTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { MembersPanel } from './MembersPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { DeadLettersPanel, type DeadLetter } from './DeadLettersPanel'
import { RunExplainChat } from './RunExplainChat'
import { nodeTypes } from '../constants'

type RightPanelProps = {
  tab: ActiveTab
  events: RunEvent[]
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
  onReplayDeadLetter: (id: string) => void
  onResolveDeadLetter: (id: string) => void
}

export function RightPanel(props: RightPanelProps) {
  if (props.tab === 'crew') return <PanelChrome title="Crew Timeline"><CrewTimeline events={props.events} /></PanelChrome>
  if (props.tab === 'workflows') return <PanelChrome title="Saved Workflows"><WorkflowsDashboard onOpen={props.onOpenWorkflow} /></PanelChrome>
  if (props.tab === 'members') return <PanelChrome title="Members"><MembersPanel /></PanelChrome>
  if (props.tab === 'inspector') return (
    <PanelChrome title="Inspector">
      <InspectorPanel
        selectedNode={props.selectedNode}
        selectedEdge={props.selectedEdge}
        runNodes={props.runNodes}
        validationIssues={props.validationIssues}
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
      onReplayDeadLetter={props.onReplayDeadLetter}
      onResolveDeadLetter={props.onResolveDeadLetter}
    />
  )
  return <PanelChrome title="Reasoning"><ReasoningPanel events={props.events} /></PanelChrome>
}

function PanelChrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="section-kicker">Control Surface</div>
        <h2>{title}</h2>
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
  onUpdateNodeConfig,
  onUpdateNodeType,
  onUpdateEdgeCondition,
}: Pick<RightPanelProps, 'selectedNode' | 'selectedEdge' | 'runNodes' | 'validationIssues' | 'onUpdateNodeConfig' | 'onUpdateNodeType' | 'onUpdateEdgeCondition'>) {
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nodeStatus = selectedNode ? runNodes.find(node => node.nodeId === selectedNode.id) : null
  const nodeIssues = selectedNode ? validationIssues.filter(issue => issue.nodeId === selectedNode.id) : []

  if (selectedNode) {
    return (
      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">Node</div>
            <h3>{selectedNode.id}</h3>
          </div>
          <span className="status-pill" data-status={nodeStatus?.status ?? 'draft'}>{nodeStatus?.status ?? 'draft'}</span>
        </div>

        <label className="field-label" htmlFor="node-type">Type</label>
        <select id="node-type" className="text-field" value={selectedNode.data.type} onChange={event => onUpdateNodeType(event.target.value)}>
          {nodeTypes.map(type => <option key={type} value={type}>{type}</option>)}
        </select>

        <label className="field-label" htmlFor="node-config">Config JSON</label>
        <textarea
          key={selectedNode.id}
          id="node-config"
          className="code-field"
          defaultValue={JSON.stringify(selectedNode.data.config, null, 2)}
          onBlur={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as Record<string, unknown>
              onUpdateNodeConfig(parsed)
              setJsonError(null)
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : 'Invalid JSON')
            }
          }}
        />

        {jsonError && <div className="issue issue-error">{jsonError}</div>}
        {nodeIssues.map(issue => <div key={`${issue.code}-${issue.message}`} className="issue issue-error">{issue.message}</div>)}
      </section>
    )
  }

  if (selectedEdge) {
    return (
      <section className="panel-card">
        <div className="section-kicker">Edge</div>
        <h3>{selectedEdge.source} to {selectedEdge.target}</h3>
        <label className="field-label" htmlFor="edge-condition">Condition</label>
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

  return (
    <section className="panel-card">
      <div className="empty-state">No selection.</div>
    </section>
  )
}

function TemplatesPanel({ templates, onUseTemplate }: Pick<RightPanelProps, 'templates' | 'onUseTemplate'>) {
  return (
    <PanelChrome title="Templates">
      <div className="panel-list">
        {templates.map(template => (
          <button key={template.id} className="list-card list-card-button" onClick={() => onUseTemplate(template.workflow)}>
            <span className="section-kicker">{template.category}</span>
            <strong>{template.name}</strong>
            <span>{template.description}</span>
          </button>
        ))}
      </div>
    </PanelChrome>
  )
}

function ToolsPanel({ tools, onInstallPlugin }: Pick<RightPanelProps, 'tools' | 'onInstallPlugin'>) {
  return (
    <PanelChrome title="Tool Catalog">
      <div className="panel-list">
        {tools.map(tool => (
          <div key={tool.name} className="list-card">
            <strong>{tool.name}</strong>
            <span>{tool.description}</span>
            <button className="small-command" onClick={() => onInstallPlugin(tool.name)}>Install</button>
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
    <PanelChrome title="Credentials">
      <section className="panel-card">
        <label className="field-label" htmlFor="credential-name">Name</label>
        <input id="credential-name" className="text-field" value={name} onChange={event => setName(event.target.value)} />
        <label className="field-label" htmlFor="credential-kind">Kind</label>
        <input id="credential-kind" className="text-field" value={kind} onChange={event => setKind(event.target.value)} />
        <label className="field-label" htmlFor="credential-secret">Secret ref</label>
        <input id="credential-secret" className="text-field" value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder="SLACK_BOT_TOKEN" />
        <button
          className="command-button command-button-primary"
          onClick={() => {
            onCreateCredential({ name: name || 'API Key', kind, secretRef: secretRef || 'MY_SECRET' })
            setName('')
            setSecretRef('')
          }}
        >
          Add credential
        </button>
      </section>
      <div className="panel-list">
        {credentials.map(credential => (
          <div key={credential.id} className="list-card">
            <strong>{credential.name}</strong>
            <span>{credential.kind} / {'{{secret.' + credential.secretRef + '}}'}</span>
          </div>
        ))}
      </div>
    </PanelChrome>
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
  onReplayDeadLetter,
  onResolveDeadLetter,
}: Pick<RightPanelProps, 'runs' | 'usage' | 'runNodes' | 'activeRunId' | 'deadLetters' | 'onOpenRun' | 'onRefreshPlatform' | 'onApproveNode' | 'onReplayNode' | 'onReplayDeadLetter' | 'onResolveDeadLetter'>) {
  const waitingNodes = runNodes.filter(node => node.status === 'waiting')
  const failedNodes = runNodes.filter(node => node.status === 'failed')

  return (
    <PanelChrome title="Runs">
      <section className="panel-card">
        <div className="split-row">
          <strong>Usage</strong>
          <button className="small-command" onClick={onRefreshPlatform}>Refresh</button>
        </div>
        <pre className="mini-pre">{JSON.stringify(usage, null, 2)}</pre>
      </section>

      {waitingNodes.length > 0 && (
        <section className="panel-card">
          <strong>Waiting nodes</strong>
          {waitingNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onApproveNode(node.nodeId)}>
              Approve {node.nodeId}
            </button>
          ))}
        </section>
      )}

      {failedNodes.length > 0 && (
        <section className="panel-card">
          <strong>Failed nodes</strong>
          {failedNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onReplayNode(node.nodeId)}>
              Replay {node.nodeId}
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
        {runs.length === 0 && <p className="empty-state">No runs yet. Press Run to execute the current workflow.</p>}
        {runs.map(run => (
          <button key={run.id} className="list-card list-card-button" onClick={() => onOpenRun(run.id)}>
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{run.id.slice(0, 8)}…</strong>
              <span className="status-pill" data-status={run.status}>{run.status}</span>
            </div>
            <span>{run.createdAt ? new Date(run.createdAt).toLocaleString() : 'run'}</span>
          </button>
        ))}
      </div>
    </PanelChrome>
  )
}

function ReasoningPanel({ events }: { events: RunEvent[] }) {
  const visibleEvents = useMemo(() => events.slice(-30).reverse(), [events])

  return (
    <div className="panel-list">
      {visibleEvents.map(event => (
        <div key={event.id} className="list-card">
          <strong>{event.type}</strong>
          <span>{event.nodeId ?? 'run'}</span>
          <pre className="mini-pre">{JSON.stringify(event.payload ?? {}, null, 2)}</pre>
        </div>
      ))}
    </div>
  )
}
