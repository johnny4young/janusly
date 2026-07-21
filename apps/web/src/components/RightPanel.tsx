/**
 * Right-side workspace panel — the tab-aware router that switches between
 * AI Studio, Inspector, Templates, Tools, Credentials, the unified Runs
 * workspace, Operations, Members, and the expert full-view tabs.
 *
 * Heavier tabs live in sibling files (`InspectorPanel.tsx`, `RunWorkspace.tsx`,
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

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, Boxes, Database, FlaskConical, GitBranch, KeyRound, Layers3, LockKeyhole, Plug, Search, ShieldCheck, Users, Workflow } from 'lucide-react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, AiCandidateBackoff, AiHealth, AiMode, AiReviewIssue, Credential, ReadinessResult, RunEvent, RunNode, RunSummary, SavedWorkflow, SolutionPackPublic, Template, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { AiCopilotPanel } from './AiCopilotPanel'
import { InspectorPanel } from './InspectorPanel'
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { EmptyView, PanelChrome, PanelSearch } from './panel-primitives'
// Tab-specific panels are code-split out of the eager App chunk: each is only
// rendered when the operator navigates to its own tab (never on Home or the
// default authoring tab), so it loads on demand behind the shared <Suspense> in
// RightPanel. AI Studio + the core Inspector (node/edge config) stay eager above
// — they're the operator's immediate authoring surface. The inspector's auxiliary
// sub-panels (version history / SLO / schedule history / metadata) are also lazy,
// rendered behind an inner <Suspense> so the node config stays instant while they
// load on first inspector visit. OperationsPage additionally pulls ~11 admin
// sub-panels + alert/budget/scim/permission forms.
const MultiAgentTimeline = lazy(() => import('../MultiAgentTimeline').then((m) => ({ default: m.MultiAgentTimeline })))
const WorkflowsDashboard = lazy(() => import('./WorkflowsDashboard').then((m) => ({ default: m.WorkflowsDashboard })))
const MembersPanel = lazy(() => import('./MembersPanel').then((m) => ({ default: m.MembersPanel })))
const SolutionPacksPanel = lazy(() => import('./SolutionPacksPanel').then((m) => ({ default: m.SolutionPacksPanel })))
const OperationsPage = lazy(() => import('./OperationsPage').then((m) => ({ default: m.OperationsPage })))
const ExperimentsPanel = lazy(() => import('./ExperimentsPanel').then((m) => ({ default: m.ExperimentsPanel })))
const RunWorkspace = lazy(() => import('./RunWorkspace').then((m) => ({ default: m.RunWorkspace })))
const ReasoningPanel = lazy(() => import('./ReasoningPanel').then((m) => ({ default: m.ReasoningPanel })))
const CredentialRotateModal = lazy(() => import('./CredentialRotateModal').then((m) => ({ default: m.CredentialRotateModal })))
const VersionHistoryPanel = lazy(() => import('./VersionHistoryPanel').then((m) => ({ default: m.VersionHistoryPanel })))
const WorkflowRolloutPanel = lazy(() => import('./WorkflowRolloutPanel').then((m) => ({ default: m.WorkflowRolloutPanel })))
const WorkflowSloPanel = lazy(() => import('./WorkflowSloPanel').then((m) => ({ default: m.WorkflowSloPanel })))
const ScheduleHistoryPanel = lazy(() => import('./ScheduleHistoryPanel').then((m) => ({ default: m.ScheduleHistoryPanel })))
const WorkflowMetadataPanel = lazy(() => import('./WorkflowMetadataPanel').then((m) => ({ default: m.WorkflowMetadataPanel })))
import { api } from '../api'
import { expiryStatus } from '../credential-expiry'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tTemplateCategory, tTemplateDescription, tTemplateName, tToolDescription, useT } from '../i18n'

export type RightPanelAuthoring = {
  aiHealth: AiHealth | null
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
  /** Declared workflow input shape; rendered in the no-selection inspector card. */
  currentWorkflowInputs?: WorkflowDefinition['inputs']
  /** Declared workflow output projection; rendered alongside `currentWorkflowInputs`. */
  currentWorkflowOutputs?: WorkflowDefinition['outputs']
  onUpdateNodeConfig: (config: Record<string, unknown>) => void
  onUpdateNodeType: (type: string) => void
  onUpdateEdgeCondition: (edgeId: string, condition: string) => void
  onValidateWorkflow(): Promise<boolean>
  /** Opens the "Insert snippet…" dialog (also bound to a Cmd+K palette entry). */
  onInsertSnippet: () => void
  /** Resolves `null` when the author declined the unsaved-canvas guard. */
  onGenerateWorkflow: (prompt: string) => Promise<{
    mode: AiMode
    workflow: WorkflowDefinition
    aiError?: string
    bonBackoff?: AiCandidateBackoff
  } | null>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string }>
  onReviewWorkflow: () => Promise<{
    mode: AiMode
    review: { status: 'pass' | 'warn' | 'fail'; issues: Array<{ code: string; severity: 'info' | 'warn' | 'fail'; message: string; nodeId?: string; edgeId?: string; rationale: string; suggestion: string }> }
    model?: string
    aiError?: string
  }>
}

export type RightPanelCatalog = {
  tools: ToolSchema[]
  templates: Template[]
  solutionPacks: SolutionPackPublic[]
  credentials: Credential[]
  workflows: SavedWorkflow[]
  onOpenWorkflow: (id: string) => void
  onUseTemplate: (workflow: WorkflowDefinition) => void
  onInstallPlugin: (pluginId: string) => void
  onInstallPack: (packId: string) => void
  onSampleRunPack: (packId: string) => void
  onInjectPackFailure: (packId: string, fixtureId: string) => void
  onCreateCredential: (credential: { name: string; kind: string; secretRef: string; expiresAt?: string }) => void
}

export type RightPanelExecution = {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  runNodes: RunNode[]
  runs: RunSummary[]
  workflows: SavedWorkflow[]
  activeRunId?: string | null
  usage: Record<string, number>
  onOpenRun: (id: string) => void
  onRefreshPlatform: () => void
  onApproveNode: (nodeId: string) => void
  onSubmitHumanForm: (nodeId: string, input: unknown, resumeToken: string) =>
    Promise<string[] | undefined> | string[] | undefined
  onReplayNode: (nodeId: string) => void
  onRedriveNode: (nodeId: string) => void
  onCancelActiveRun?: () => void | Promise<void>
  onReplayDeadLetter: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolveDeadLetter: (id: string) => boolean | Promise<boolean> | undefined
}

export type RightPanelNavigation = {
  onOpenTab: (tab: ActiveTab) => void
}

export type RightPanelProps = {
  tab: ActiveTab
  authoring: RightPanelAuthoring
  catalog: RightPanelCatalog
  execution: RightPanelExecution
  navigation: RightPanelNavigation
}

/** Tab-aware right-side panel — wraps the tab→panel router in a single
 *  <Suspense> so the lazy tab panels (multi-agent / workflows / members / packs
 *  / operations / runs) render a brief fallback on first open instead of
 *  shipping in the eager App chunk. */
export function RightPanel(props: RightPanelProps) {
  const { t } = useT()
  return (
    <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
      <RightPanelRouter {...props} />
    </Suspense>
  )
}

/** Tab→panel router — picks the inner panel component for the active tab. The
 *  'home' tab is intentionally handled by `App.tsx` at the layout level (panel
 *  slot is null, Recovery Center goes in the main area so it has hero-page real
 *  estate); this dispatcher never receives it. */
function RightPanelRouter(props: RightPanelProps) {
  const { t } = useT()
  const { authoring, catalog, execution, navigation } = props
  const loadRunUsage = useCallback((runId: string, signal: AbortSignal) =>
    api(`/run/usage?runId=${encodeURIComponent(runId)}`, { signal }), [])
  const replayDecision = useCallback((eventId: string, nodeId: string, signal: AbortSignal) => {
    if (!execution.activeRunId) return Promise.resolve(null)
    return api(`/causal?runId=${encodeURIComponent(execution.activeRunId)}&eventId=${encodeURIComponent(eventId)}&nodeId=${encodeURIComponent(nodeId)}`, { signal })
  }, [execution.activeRunId])
  if (props.tab === 'copilot') return (
    <AiCopilotPanel
      health={authoring.aiHealth}
      workflowName={authoring.currentWorkflowName}
      onGenerateWorkflow={authoring.onGenerateWorkflow}
      onExplainWorkflow={authoring.onExplainWorkflow}
      onReviewWorkflow={authoring.onReviewWorkflow}
      onOpenRuns={() => navigation.onOpenTab('runs')}
      onOpenTemplates={() => navigation.onOpenTab('templates')}
    />
  )
  if (props.tab === 'multiAgent') return (
    <PanelChrome title={t('rightPanel.multiAgent.title')} description={t('rightPanel.multiAgent.description')} icon={<Layers3 size={18} />}>
      <MultiAgentTimeline events={execution.events} eventsHasMore={execution.eventsHasMore} onLoadOlderEvents={execution.onLoadOlderEvents} />
    </PanelChrome>
  )
  if (props.tab === 'workflows') return (
    <PanelChrome title={t('rightPanel.workflows.title')} description={t('rightPanel.workflows.description')} icon={<Database size={18} />}>
      <WorkflowsDashboard onOpen={catalog.onOpenWorkflow} />
    </PanelChrome>
  )
  if (props.tab === 'operations') return <OperationsPage />
  if (props.tab === 'experiments') return (
    <PanelChrome title={t('rightPanel.experiments.title')} description={t('rightPanel.experiments.description')} icon={<FlaskConical size={18} />}>
      <ExperimentsPanel />
    </PanelChrome>
  )
  if (props.tab === 'members') return (
    <PanelChrome title={t('rightPanel.members.title')} description={t('rightPanel.members.description')} icon={<Users size={18} />}>
      <MembersPanel />
    </PanelChrome>
  )
  if (props.tab === 'inspector') return (
    <PanelChrome title={t('rightPanel.inspector.title')} description={t('rightPanel.inspector.description')} icon={<GitBranch size={18} />}>
      <AuthoringProblemsPanel
        validationIssues={authoring.validationIssues}
        readiness={authoring.readinessResult}
        aiReviewIssues={authoring.aiReviewIssues}
        workflowEdges={authoring.workflowEdges}
        onValidate={authoring.onValidateWorkflow}
      />
      <InspectorPanel
        selectedNode={authoring.selectedNode}
        selectedEdge={authoring.selectedEdge}
        runNodes={authoring.runNodes}
        validationIssues={authoring.validationIssues}
        tools={authoring.tools}
        workflows={authoring.workflows}
        workflowNodes={authoring.workflowNodes}
        workflowEdges={authoring.workflowEdges}
        currentWorkflowId={authoring.currentWorkflowId}
        currentWorkflowName={authoring.currentWorkflowName}
        currentWorkflowInputs={authoring.currentWorkflowInputs}
        currentWorkflowOutputs={authoring.currentWorkflowOutputs}
        onUpdateNodeConfig={authoring.onUpdateNodeConfig}
        onUpdateNodeType={authoring.onUpdateNodeType}
        onUpdateEdgeCondition={authoring.onUpdateEdgeCondition}
        onInsertSnippet={authoring.onInsertSnippet}
      />
      {/* Auxiliary inspector panels are lazy — an inner <Suspense> (below the
          eager InspectorPanel) keeps the node config instant while these load on
          first inspector visit. `null` fallback: they're secondary and three
          self-gate to null on unsaved drafts, so a "Working…" line would flash
          spuriously under a ready config. */}
      <Suspense fallback={null}>
        <VersionHistoryPanel />
        <WorkflowRolloutPanel />
        <WorkflowSloPanel />
        <ScheduleHistoryPanel />
        <WorkflowMetadataPanel />
      </Suspense>
    </PanelChrome>
  )
  if (props.tab === 'templates') return <TemplatesPanel templates={catalog.templates} onUseTemplate={catalog.onUseTemplate} />
  if (props.tab === 'packs') return (
    <SolutionPacksPanel
      packs={catalog.solutionPacks}
      credentials={catalog.credentials}
      onInstall={catalog.onInstallPack}
      onSampleRun={catalog.onSampleRunPack}
      onInjectFailure={catalog.onInjectPackFailure}
    />
  )
  if (props.tab === 'marketplace') return <ToolsPanel tools={catalog.tools} onInstallPlugin={catalog.onInstallPlugin} />
  if (props.tab === 'credentials') return <CredentialsPanel credentials={catalog.credentials} onCreateCredential={catalog.onCreateCredential} />
  if (props.tab === 'runs') return (
    <RunWorkspace
      runs={execution.runs}
      workflows={execution.workflows}
      usage={execution.usage}
      runNodes={execution.runNodes}
      runEvents={execution.events}
      eventsHasMore={execution.eventsHasMore}
      onLoadOlderEvents={execution.onLoadOlderEvents}
      activeRunId={execution.activeRunId}
      onOpenRun={execution.onOpenRun}
      onRefreshPlatform={execution.onRefreshPlatform}
      onApproveNode={execution.onApproveNode}
      onSubmitHumanForm={execution.onSubmitHumanForm}
      onReplayNode={execution.onReplayNode}
      onRedriveNode={execution.onRedriveNode}
      onCancelActiveRun={execution.onCancelActiveRun}
      onReplayDeadLetter={execution.onReplayDeadLetter}
      onResolveDeadLetter={execution.onResolveDeadLetter}
      onLoadRunUsage={loadRunUsage}
      onReplayDecision={execution.activeRunId ? replayDecision : undefined}
      onOpenFullView={navigation.onOpenTab}
    />
  )
  return (
    <PanelChrome title={t('rightPanel.reasoning.title')} description={t('rightPanel.reasoning.description')} icon={<Activity size={18} />}>
      <ReasoningPanel
        events={execution.events}
        eventsHasMore={execution.eventsHasMore}
        onLoadOlderEvents={execution.onLoadOlderEvents}
        activeRunId={execution.activeRunId}
        onLoadRunUsage={loadRunUsage}
        onReplayDecision={execution.activeRunId ? replayDecision : undefined}
      />
    </PanelChrome>
  )
}

export function TemplatesPanel({ templates, onUseTemplate }: Pick<RightPanelCatalog, 'templates' | 'onUseTemplate'>) {
  const { t, i18n } = useT()
  const setActiveTab = useWorkflowStore(state => state.setActiveTab)
  const [query, setQuery] = useState('')
  // `tTemplate*` read the active locale via the runtime translator (not the
  // closure `t`), so include `i18n.language` so the filter re-runs on a locale
  // switch — mirroring the MultiAgentTimeline memo.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(template =>
      `${tTemplateName(template)} ${tTemplateDescription(template)} ${tTemplateCategory(template)}`.toLowerCase().includes(q),
    )
  }, [templates, query, i18n.language])

  return (
    <PanelChrome title={t('rightPanel.templates.title')} description={t('rightPanel.templates.description')} icon={<Workflow size={18} />}>
      {templates.length === 0 ? (
        <div className="panel-list">
          <EmptyView
            icon={<Workflow size={22} />}
            title={t('rightPanel.templates.empty.title')}
            body={t('rightPanel.templates.empty.body')}
            cta={{ label: t('rightPanel.templates.empty.cta'), onClick: () => setActiveTab('copilot') }}
          />
        </div>
      ) : (
        <>
          <PanelSearch value={query} onChange={setQuery} placeholder={t('rightPanel.templates.searchPlaceholder')} />
          {filtered.length === 0 ? (
            <div className="panel-list">
              <EmptyView
                icon={<Search size={22} />}
                title={t('rightPanel.templates.noMatches.title')}
                body={t('rightPanel.templates.noMatches.body')}
                cta={{ label: t('common.clearFilter'), onClick: () => setQuery('') }}
              />
            </div>
          ) : (
            <div className="we-recipe-grid">
              {filtered.map(template => (
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
          )}
        </>
      )}
    </PanelChrome>
  )
}

function ToolsPanel({ tools, onInstallPlugin }: Pick<RightPanelCatalog, 'tools' | 'onInstallPlugin'>) {
  const { t } = useT()
  return (
    <PanelChrome title={t('rightPanel.tools.title')} description={t('rightPanel.tools.description')} icon={<Boxes size={18} />}>
      <div className="panel-list">
        {tools.length === 0 && <EmptyView icon={<Plug size={22} />} title={t('rightPanel.tools.empty.title')} body={t('rightPanel.tools.empty.body')} />}
        {tools.map(tool => (
          <div key={tool.name} className="list-card">
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{tool.name}</strong>
              <span className="we-pill" data-tone="warning">{t('rightPanel.tools.requiredCount', { count: tool.required?.length ?? 0 })}</span>
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
type CredentialHealthLite = { name: string; secretRefPresent: boolean; lastUsedAt: string | null; expiresAt: string | null }

/** Env-var NAME shape the server accepts for `secretRef` (mirrors the
 *  rotate modal). The secret VALUE never lives here — only the env-var name. */
const CREDENTIAL_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/

/** Connection kinds the integration chokepoint recognizes. Free-form on the
 *  server, but the select keeps operators on the known set. */
const CREDENTIAL_KINDS = [
  'generic',
  'github_token',
  'slack_webhook',
  'slack_signing_secret',
  'webhook_secret',
  'postgres',
] as const

function CredentialsPanel({ credentials, onCreateCredential }: Pick<RightPanelCatalog, 'credentials' | 'onCreateCredential'>) {
  const { t } = useT()
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [secretRef, setSecretRef] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [rotating, setRotating] = useState<string | null>(null)
  const [healthByName, setHealthByName] = useState<Map<string, CredentialHealthLite>>(new Map())
  const [expiryNowMs, setExpiryNowMs] = useState(() => Date.now())

  useEffect(() => {
    setExpiryNowMs(Date.now())
    const interval = window.setInterval(() => setExpiryNowMs(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

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
    <PanelChrome title={t('rightPanel.credentials.title')} description={t('rightPanel.credentials.description')} icon={<KeyRound size={18} />}>
      <section className="we-card connection-form">
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
            placeholder={t('rightPanel.credentials.envPlaceholder')}
            aria-invalid={refInvalid}
            aria-describedby={refInvalid ? 'credential-secret-error' : undefined}
          />
          {refInvalid && (
            <span id="credential-secret-error" className="helper-text helper-text--error" role="alert">
              <AlertCircle size={13} aria-hidden="true" /> {t('rightPanel.credentials.envInvalid')}
            </span>
          )}
          <label className="field-label" htmlFor="credential-expiry">{t('rightPanel.credentials.expiryLabel')}</label>
          <input
            id="credential-expiry"
            type="date"
            className="text-field"
            value={expiresAt}
            onChange={event => setExpiresAt(event.target.value)}
          />
          <span className="helper-text">{t('rightPanel.credentials.expiryHint')}</span>
        </fieldset>
        <div className="form-actions connection-form-actions">
          <button
            className="command-button command-button-primary"
            disabled={!canAdd}
            onClick={() => {
              onCreateCredential({
                name: name.trim(),
                kind,
                secretRef: trimmedRef,
                // Date input gives YYYY-MM-DD; send an ISO instant (UTC midnight).
                ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
              })
              setName('')
              setSecretRef('')
              setExpiresAt('')
            }}
          >
            {t('rightPanel.credentials.addButton')}
          </button>
        </div>
      </section>
      <div className="panel-list">
        {credentials.length === 0 && <EmptyView icon={<ShieldCheck size={22} />} title={t('rightPanel.credentials.empty.title')} body={t('rightPanel.credentials.empty.body')} />}
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
                  title={t('rightPanel.credentials.secretRefHidden')}
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
                {(() => {
                  // Expiry badge from the health snapshot's `expiresAt`. Only the
                  // actionable states render a pill (expired = red, soon = amber);
                  // healthy/no-expiry credentials show nothing.
                  const expiry = expiryStatus(health?.expiresAt, expiryNowMs)
                  if (expiry.kind === 'expired') {
                    return (
                      <span className="we-pill" data-tone="danger" data-testid="credential-expiry-badge">
                        {t('rightPanel.credentials.expiry.expired')}
                      </span>
                    )
                  }
                  if (expiry.kind === 'soon') {
                    return (
                      <span className="we-pill" data-tone="warning" data-testid="credential-expiry-badge">
                        {t('rightPanel.credentials.expiry.expiresInDays', { count: expiry.days })}
                      </span>
                    )
                  }
                  return null
                })()}
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
      {rotating && (
        <Suspense fallback={null}>
          <CredentialRotateModal credentialName={rotating} onClose={() => setRotating(null)} />
        </Suspense>
      )}
    </PanelChrome>
  )
}
