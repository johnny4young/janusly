/**
 * Right-side workspace panel — the tab-aware router that switches between
 * AI Studio, Inspector, Templates, Tools, Credentials, Runs, Multi-agent
 * timeline, Operations, Members, Reasoning, and Workflows tabs.
 *
 * Heavier tabs live in sibling files (`InspectorPanel.tsx`, `RunsPanel.tsx`,
 * `UsageSummaryCard.tsx`, `QuickConfigEditor.tsx`, `McpToolConfigField.tsx`,
 * `AiUsageFooter.tsx`). The thinner tabs (Templates / Tools / Credentials /
 * Reasoning) stay here because they're small and single-purpose. `PanelChrome`
 * + `EmptyView` live in the sibling `panel-primitives.tsx` file so the
 * extracted sub-panels reuse them without a circular `./RightPanel` import.
 *
 * Used by `App.tsx` (top-level routing on `tab`).
 *
 * Invariants:
 * - Mutations that invalidate server data call `bumpPlatformVersion()` so
 *   sibling panels refetch (AGENTS.md cross-panel reactivity).
 * - Web deps locked to the AGENTS.md whitelist plus
 *   `@janusly/shared/src/status` for zero-dep lifecycle guards. Don't add
 *   radix / cva / clsx / tailwind-merge / shadcn here.
 */

import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, Boxes, Database, GitBranch, KeyRound, Layers3, LockKeyhole, Plug, ShieldCheck, Users, Workflow } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, AiHealth, AiMode, Credential, McpConnection, McpToolDescriptor, RunEvent, RunNode, RunSummary, SolutionPackPublic, Template, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { MultiAgentTimeline } from '../MultiAgentTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { MembersPanel } from './MembersPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { WorkflowSloPanel } from './WorkflowSloPanel'
import { WorkflowMetadataPanel } from './WorkflowMetadataPanel'
import { ScheduleHistoryPanel } from './ScheduleHistoryPanel'
import { CredentialRotateModal } from './CredentialRotateModal'
import { type DeadLetter } from './DeadLettersPanel'
import { AiCopilotPanel } from './AiCopilotPanel'
import { InspectorPanel } from './InspectorPanel'
import { SolutionPacksPanel } from './SolutionPacksPanel'
import { EmptyView, PanelChrome } from './panel-primitives'
// Operations pulls 11 admin sub-panels + alert/budget/scim/permission forms
// that canvas/Home users never touch — code-split it out of the main chunk.
const OperationsPage = lazy(() => import('./OperationsPage').then((m) => ({ default: m.OperationsPage })))
import { RunsPanel } from './RunsPanel'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tTemplateCategory, tTemplateDescription, tTemplateName, tToolDescription, useT } from '../i18n'

export type RightPanelProps = {
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
  solutionPacks: SolutionPackPublic[]
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
  onInstallPack: (packId: string) => void
  onSampleRunPack: (packId: string) => void
  onInjectPackFailure: (packId: string) => void
  onCreateCredential: (credential: { name: string; kind: string; secretRef: string }) => void
  onOpenRun: (id: string) => void
  onRefreshPlatform: () => void
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
  /** Opens the "Insert snippet…" dialog (also bound to a Cmd+K palette entry). */
  onInsertSnippet: () => void
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
  if (props.tab === 'operations') return (
    <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
      <OperationsPage />
    </Suspense>
  )
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
        currentWorkflowName={props.currentWorkflowName}
        currentWorkflowInputs={props.currentWorkflowInputs}
        currentWorkflowOutputs={props.currentWorkflowOutputs}
        onUpdateNodeConfig={props.onUpdateNodeConfig}
        onUpdateNodeType={props.onUpdateNodeType}
        onUpdateEdgeCondition={props.onUpdateEdgeCondition}
        onInsertSnippet={props.onInsertSnippet}
      />
      <VersionHistoryPanel />
      <WorkflowSloPanel />
      <ScheduleHistoryPanel />
      <WorkflowMetadataPanel />
    </PanelChrome>
  )
  if (props.tab === 'templates') return <TemplatesPanel templates={props.templates} onUseTemplate={props.onUseTemplate} />
  if (props.tab === 'packs') return (
    <SolutionPacksPanel
      packs={props.solutionPacks}
      credentials={props.credentials}
      onInstall={props.onInstallPack}
      onSampleRun={props.onSampleRunPack}
      onInjectFailure={props.onInjectPackFailure}
    />
  )
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

function TemplatesPanel({ templates, onUseTemplate }: Pick<RightPanelProps, 'templates' | 'onUseTemplate'>) {
  const { t } = useT()
  return (
    <PanelChrome title={t('rightPanel.templates.title') as string} description={t('rightPanel.templates.description') as string} icon={<Workflow size={18} />}>
      {templates.length === 0 && (
        <div className="panel-list">
          <EmptyView icon={<Workflow size={22} />} title={t('rightPanel.templates.empty.title') as string} body={t('rightPanel.templates.empty.body') as string} />
        </div>
      )}
      <div className="we-recipe-grid">
        {templates.map(template => (
          <button key={template.id} className="list-card list-card-button" onClick={() => onUseTemplate(template.workflow)}>
            <div className="split-row" style={{ width: '100%' }}>
              <span className="mode-pill mode-pill-neutral">{tTemplateCategory(template)}</span>
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
              <span className="we-pill we-pill--amber">{t('rightPanel.tools.requiredCount', { count: tool.required?.length ?? 0 })}</span>
            </div>
            <span>{tToolDescription(tool)}</span>
            {(tool.required?.length || tool.optional?.length) ? (
              <div className="we-tool-params">
                {(tool.required ?? []).map(field => <span key={`required-${field}`} className="we-param we-param--required">{field}</span>)}
                {(tool.optional ?? []).map(field => <span key={`optional-${field}`} className="we-param we-param--optional">{field}</span>)}
              </div>
            ) : null}
            <button className="small-command" onClick={() => onInstallPlugin(tool.name)}>{t('rightPanel.tools.installTool')}</button>
          </div>
        ))}
      </div>
    </PanelChrome>
  )
}

/** Minimal slice of `GET /credentials/health` the Connections vault list
 *  consumes to show linked-vs-missing per reference. Connections is the
 *  sole vault editor; Operations Integrations mirrors the same snapshot
 *  read-only. The env-var NAME never reaches this shape (server posture). */
type CredentialHealthLite = { name: string; secretRefPresent: boolean; lastUsedAt: string | null }

/** Env-var NAME shape the server accepts for `secretRef` (mirrors the
 *  rotate modal). The secret VALUE never lives here — only the env-var name. */
const CREDENTIAL_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/

/** Connection kinds the integration chokepoint recognizes. Free-form on the
 *  server, but the select keeps operators on the known set. */
const CREDENTIAL_KINDS = ['generic', 'github_token', 'slack_webhook', 'webhook_secret'] as const

function CredentialsPanel({ credentials, onCreateCredential }: Pick<RightPanelProps, 'credentials' | 'onCreateCredential'>) {
  const { t } = useT()
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [secretRef, setSecretRef] = useState('')
  const [rotating, setRotating] = useState<string | null>(null)
  const [healthByName, setHealthByName] = useState<Map<string, CredentialHealthLite>>(new Map())

  useEffect(() => {
    let cancelled = false
    api('/credentials/health')
      .then(res => {
        if (cancelled) return
        const raw = (res ?? {}) as { credentials?: CredentialHealthLite[] }
        const map = new Map<string, CredentialHealthLite>()
        for (const entry of Array.isArray(raw.credentials) ? raw.credentials : []) {
          if (entry && typeof entry.name === 'string') map.set(entry.name, entry)
        }
        setHealthByName(map)
      })
      // Health is a best-effort enrichment — the vault list still renders
      // (with the hidden-reference reassurance) if the snapshot is unavailable.
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [platformVersion])

  const trimmedRef = secretRef.trim()
  const refInvalid = trimmedRef.length > 0 && !CREDENTIAL_ENV_VAR_NAME.test(trimmedRef)
  const canAdd = name.trim().length > 0 && CREDENTIAL_ENV_VAR_NAME.test(trimmedRef)

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
        <fieldset className="we-fieldset">
          <label className="field-label" htmlFor="credential-name">{t('rightPanel.credentials.nameLabel')}</label>
          <input id="credential-name" className="text-field" value={name} onChange={event => setName(event.target.value)} />
          <label className="field-label" htmlFor="credential-kind">{t('rightPanel.credentials.kindLabel')}</label>
          <select id="credential-kind" className="text-field" value={kind} onChange={event => setKind(event.target.value)}>
            {CREDENTIAL_KINDS.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <label className="field-label" htmlFor="credential-secret">{t('rightPanel.credentials.envLabel')}</label>
          <input
            id="credential-secret"
            className={`text-field${refInvalid ? ' text-field--error' : ''}`}
            value={secretRef}
            onChange={event => setSecretRef(event.target.value)}
            placeholder={t('rightPanel.credentials.envPlaceholder') as string}
            aria-invalid={refInvalid}
          />
          {refInvalid && (
            <span className="helper-text helper-text--error" role="alert">
              <AlertCircle size={13} aria-hidden="true" /> {t('rightPanel.credentials.envInvalid')}
            </span>
          )}
        </fieldset>
        <div className="form-actions connection-form-actions">
          <button
            className="command-button command-button-primary"
            disabled={!canAdd}
            onClick={() => {
              onCreateCredential({ name: name.trim(), kind, secretRef: trimmedRef })
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
        {credentials.map(credential => {
          const health = healthByName.get(credential.name)
          const linked = health?.secretRefPresent === true
          return (
            <div key={credential.id} className="list-card">
              <div className="split-row" style={{ width: '100%' }}>
                <strong>{credential.name}</strong>
                <span className="mode-pill mode-pill-neutral">{credential.kind}</span>
              </div>
              <div className="split-row" style={{ width: '100%' }}>
                {/* Always a status pill — never the old plain-text fallback —
                    so the redesign reads even before /credentials/health
                    resolves (neutral = status not yet known). */}
                <span
                  className={`we-secret-pill we-secret-pill--${health ? (linked ? 'healthy' : 'unhealthy') : 'neutral'}`}
                  title={t('rightPanel.credentials.secretRefHidden') as string}
                >
                  {health
                    ? (linked ? t('rightPanel.credentials.status.linked') : t('rightPanel.credentials.status.missing'))
                    : t('rightPanel.credentials.status.unknown')}
                </span>
                {health?.lastUsedAt && (
                  <span className="helper-text mono">
                    {t('rightPanel.credentials.lastUsed')}: {new Date(health.lastUsedAt).toLocaleString(getResolvedLocale())}
                  </span>
                )}
              </div>
              <div className="form-actions">
                <button type="button" className="command-button" onClick={() => setRotating(credential.name)}>
                  {t('credentialRotation.action.rotate')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {rotating && <CredentialRotateModal credentialName={rotating} onClose={() => setRotating(null)} />}
    </PanelChrome>
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
