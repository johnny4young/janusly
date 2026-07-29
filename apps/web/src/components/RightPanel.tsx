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
import { Activity, AlertCircle, Boxes, Database, FlaskConical, KeyRound, Layers3, LockKeyhole, Plug, ShieldCheck, Users, Workflow } from 'lucide-react'
import type { ActiveTab, AiAuthoringActionRequest, AiCandidateBackoff, AiHealth, AiMode, Credential, RunEvent, RunNode, RunSummary, SavedWorkflow, SolutionPackPublic, Template, ToolSchema, WorkflowDefinition, WorkflowImprovementResult, WorkflowImprovementSuggestion } from '../types'
import type { DeadLetter } from './DeadLettersPanel'
import { AiCopilotPanel } from './AiCopilotPanel'
import { AuthoringPanel, type AuthoringPanelModel } from './AuthoringPanel'
import { EmptyView, PanelChrome, PanelSearch } from './panel-primitives'
import { ErrorBoundary } from './ErrorBoundary'
import { PanelErrorFallback } from './PanelErrorFallback'
import { WorkspaceSectionNav } from './WorkspaceSectionNav'
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
const ActivityWorkspace = lazy(() => import('./ActivityWorkspace').then((m) => ({ default: m.ActivityWorkspace })))
const RunsPanel = lazy(() => import('./RunsPanel').then((m) => ({ default: m.RunsPanel })))
const RecoveryCasePanel = lazy(() => import('./RecoveryCasePanel').then((m) => ({ default: m.RecoveryCasePanel })))
const ReasoningPanel = lazy(() => import('./ReasoningPanel').then((m) => ({ default: m.ReasoningPanel })))
const CredentialRotateModal = lazy(() => import('./CredentialRotateModal').then((m) => ({ default: m.CredentialRotateModal })))
import { api } from '../api'
import { expiryStatus } from '../credential-expiry'
import { useWorkflowStore } from '../store'
import { workspaceDestinationForTab } from '../workspace-locations'
import { getResolvedLocale, tTemplateCategory, tTemplateDescription, tTemplateName, tToolDescription, useT } from '../i18n'
import type { WorkflowCreationMode } from './WorkflowsDashboard'

export type RightPanelAuthoring = AuthoringPanelModel & {
  aiHealth: AiHealth | null
  aiActionRequest: AiAuthoringActionRequest | null
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
  onSuggestWorkflowImprovement: () => Promise<WorkflowImprovementResult>
  onApplyWorkflowImprovement: (suggestion: WorkflowImprovementSuggestion) => Promise<boolean>
}

export type RightPanelCatalog = {
  tools: ToolSchema[]
  templates: Template[]
  solutionPacks: SolutionPackPublic[]
  credentials: Credential[]
  workflows: SavedWorkflow[]
  onOpenWorkflow: (id: string) => void
  onCreateWorkflow: (mode: WorkflowCreationMode) => void
  onUseTemplate: (workflow: WorkflowDefinition) => void
  onInstallPlugin: (pluginId: string) => void
  onInstallPack: (packId: string) => void
  onSampleRunPack: (packId: string) => void
  onInjectPackFailure: (packId: string, fixtureId: string) => void
  onCreateCredential: (credential: {
    name: string
    kind: string
    secretValue?: string
    secretRef?: string
    expiresAt?: string
  }) => Promise<boolean>
}

export type RightPanelExecution = {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  runNodes: RunNode[]
  runs: RunSummary[]
  deadLetters: DeadLetter[]
  workflows: SavedWorkflow[]
  activeRunId?: string | null
  activeRecoveryId?: string | null
  usage: Record<string, number>
  onOpenRun: (id: string) => void | Promise<void>
  onRefreshPlatform: () => void
  onApproveNode: (nodeId: string) => void
  onSubmitHumanForm: (nodeId: string, input: unknown, resumeToken: string) =>
    Promise<string[] | undefined> | string[] | undefined
  onReplayNode: (nodeId: string) => void
  onRedriveNode: (nodeId: string) => void
  onCancelActiveRun?: () => void | Promise<void>
  onSelectRecovery: (id: string | null) => void
  onClearActiveRun: () => void
  onReplayDeadLetter: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolveDeadLetter: (id: string) => boolean | Promise<boolean> | undefined
}

export type RightPanelNavigation = {
  onOpenTab: (tab: ActiveTab) => void
  onOpenAiAction: (action: AiAuthoringActionRequest['action']) => void
  activeRecoveryCaseId: string | null
}

export type RightPanelProps = {
  tab: ActiveTab
  permissions?: readonly string[]
  authoring: RightPanelAuthoring
  catalog: RightPanelCatalog
  execution: RightPanelExecution
  navigation: RightPanelNavigation
}

/** Tab-aware right-side panel — wraps the tab→panel router in a single
 *  <Suspense> so the lazy tab panels (multi-agent / workflows / members / packs
 *  / operations / runs) render a brief fallback on first open instead of
 *  shipping in the eager App chunk.
 *
 *  The <ErrorBoundary> is the blast-radius limit: panels render whatever the
 *  API returns, and one of them dereferencing an unexpected envelope used to
 *  unmount the entire workspace. Keyed on the active tab so navigating away and
 *  back clears a tripped panel without a page reload. */
export function RightPanel(props: RightPanelProps) {
  const { t } = useT()
  return (
    <div
      className="workspace-panel-stack"
      data-destination={workspaceDestinationForTab(props.tab)}
    >
      <WorkspaceSectionNav
        activeTab={props.tab}
        permissions={props.permissions}
        onOpenTab={props.navigation.onOpenTab}
      />
      <ErrorBoundary
        resetKey={props.tab}
        logTag={`panel:${props.tab}`}
        fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
      >
        <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
          <RightPanelRouter {...props} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/** Tab→panel router — picks the inner panel component for the active tab. The
 *  'home' tab is intentionally handled by `App.tsx` at the layout level (panel
 *  slot is null, Recovery Center goes in the main area so it has hero-page real
 *  estate); this dispatcher never receives it. */
function RightPanelRouter(props: RightPanelProps) {
  const { t } = useT()
  const { authoring, catalog, execution, navigation } = props
  const can = (permission: string) => props.permissions === undefined || props.permissions.includes(permission)
  const loadRunUsage = useCallback((runId: string, signal: AbortSignal) =>
    api(`/run/usage?runId=${encodeURIComponent(runId)}`, { signal }), [])
  const replayDecision = useCallback((eventId: string, nodeId: string, signal: AbortSignal) => {
    if (!execution.activeRunId) return Promise.resolve(null)
    return api(`/causal?runId=${encodeURIComponent(execution.activeRunId)}&eventId=${encodeURIComponent(eventId)}&nodeId=${encodeURIComponent(nodeId)}`, { signal })
  }, [execution.activeRunId])
  const runsPanelProps = {
    runs: execution.runs,
    workflows: execution.workflows,
    usage: execution.usage,
    runNodes: execution.runNodes,
    runEvents: execution.events,
    activeRunId: execution.activeRunId,
    onOpenRun: execution.onOpenRun,
    onRefreshPlatform: execution.onRefreshPlatform,
    onApproveNode: execution.onApproveNode,
    onSubmitHumanForm: execution.onSubmitHumanForm,
    onReplayNode: execution.onReplayNode,
    onRedriveNode: execution.onRedriveNode,
    onCancelActiveRun: execution.onCancelActiveRun,
    onReplayDeadLetter: execution.onReplayDeadLetter,
    onResolveDeadLetter: execution.onResolveDeadLetter,
    canStartRuns: can('runs.start'),
    canCancelRuns: can('runs.cancel'),
    canReplayDeadLetters: can('dlq.replay'),
    canResolveDeadLetters: can('recovery.write'),
    canUseRecovery: can('ai.write') && can('recovery.write') && can('workflows.write') && can('dlq.replay') && can('runs.start'),
    canReadAutoHealing: can('autohealing.read'),
    canDecideAutoHealing: can('autohealing.decide'),
  }
  if (props.tab === 'copilot') return (
    <AiCopilotPanel
      health={authoring.aiHealth}
      workflowName={authoring.currentWorkflowName}
      onGenerateWorkflow={authoring.onGenerateWorkflow}
      onExplainWorkflow={authoring.onExplainWorkflow}
      onReviewWorkflow={authoring.onReviewWorkflow}
      actionRequest={authoring.aiActionRequest}
      onSuggestWorkflowImprovement={authoring.onSuggestWorkflowImprovement}
      onApplyWorkflowImprovement={authoring.onApplyWorkflowImprovement}
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
      <WorkflowsDashboard
        onOpen={catalog.onOpenWorkflow}
        onCreate={catalog.onCreateWorkflow}
        canWrite={can('workflows.write')}
      />
    </PanelChrome>
  )
  if (props.tab === 'operations') return <OperationsPage permissions={props.permissions} />
  if (props.tab === 'recoveryCase') return (
    <RecoveryCasePanel
      caseId={navigation.activeRecoveryCaseId}
      canResolve={can('recovery.write')}
      onBack={() => navigation.onOpenTab('home')}
      onOpenRun={execution.onOpenRun}
      onResolved={execution.onRefreshPlatform}
    />
  )
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
    <AuthoringPanel
      model={authoring}
      canWrite={can('workflows.write')}
      canUseAi={can('ai.write')}
      onOpenAiAction={navigation.onOpenAiAction}
    />
  )
  if (props.tab === 'templates') return (
    <TemplatesPanel
      templates={catalog.templates}
      solutionPacks={catalog.solutionPacks}
      credentials={catalog.credentials}
      onUseTemplate={catalog.onUseTemplate}
      onInstallPack={catalog.onInstallPack}
      onSampleRunPack={catalog.onSampleRunPack}
      onInjectPackFailure={catalog.onInjectPackFailure}
      canUse={can('workflows.write')}
      canInstallPacks={can('packs.install')}
    />
  )
  if (props.tab === 'packs') return (
    <SolutionPacksPanel
      packs={catalog.solutionPacks}
      credentials={catalog.credentials}
      onInstall={catalog.onInstallPack}
      onSampleRun={catalog.onSampleRunPack}
      onInjectFailure={catalog.onInjectPackFailure}
      canInstall={can('packs.install')}
    />
  )
  if (props.tab === 'marketplace') return (
    <ToolsPanel tools={catalog.tools} onInstallPlugin={catalog.onInstallPlugin} canInstall={can('workflows.write')} />
  )
  if (props.tab === 'credentials') return (
    <CredentialsPanel
      credentials={catalog.credentials}
      onCreateCredential={catalog.onCreateCredential}
      canWrite={can('credentials.write')}
    />
  )
  if (props.tab === 'recover') return (
    <RunsPanel
      {...runsPanelProps}
      mode="recovery"
    />
  )
  if (props.tab === 'runs') return (
    <ActivityWorkspace
      {...runsPanelProps}
      deadLetters={execution.deadLetters}
      activeRecoveryId={execution.activeRecoveryId}
      eventsHasMore={execution.eventsHasMore}
      onLoadOlderEvents={execution.onLoadOlderEvents}
      onLoadRunUsage={loadRunUsage}
      onReplayDecision={execution.activeRunId ? replayDecision : undefined}
      onOpenFullView={navigation.onOpenTab}
      onSelectRecovery={execution.onSelectRecovery}
      onClearActiveRun={execution.onClearActiveRun}
      onOpenRecoveryTools={() => navigation.onOpenTab('recover')}
      canReadDeadLetters={can('dlq.read')}
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

export function TemplatesPanel({
  templates,
  solutionPacks,
  credentials,
  onUseTemplate,
  onInstallPack,
  onSampleRunPack,
  onInjectPackFailure,
  canUse = true,
  canInstallPacks = true,
}: Pick<
  RightPanelCatalog,
  | 'templates'
  | 'solutionPacks'
  | 'credentials'
  | 'onUseTemplate'
  | 'onInstallPack'
  | 'onSampleRunPack'
  | 'onInjectPackFailure'
> & {
  canUse?: boolean
  canInstallPacks?: boolean
}) {
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
      {templates.length === 0 && solutionPacks.length === 0 ? (
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
          <section className="template-catalog-section">
            <div className="section-kicker">{t('rightPanel.templates.recipes')}</div>
            {filtered.length === 0 ? (
              <p className="helper-text">{t('rightPanel.templates.noRecipeMatches')}</p>
            ) : (
              <div className="we-recipe-grid">
                {filtered.map(template => (
                  <button key={template.id} className="list-card list-card-button" disabled={!canUse} onClick={() => onUseTemplate(template.workflow)}>
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
          </section>
          <section className="template-catalog-section">
            <div className="section-kicker">{t('rightPanel.templates.solutionPacks')}</div>
            <SolutionPacksPanel
              embedded
              showSearch={false}
              query={query}
              onQueryChange={setQuery}
              packs={solutionPacks}
              credentials={credentials}
              onInstall={onInstallPack}
              onSampleRun={onSampleRunPack}
              onInjectFailure={onInjectPackFailure}
              canInstall={canInstallPacks}
            />
          </section>
        </>
      )}
    </PanelChrome>
  )
}

function ToolsPanel({ tools, onInstallPlugin, canInstall }: Pick<RightPanelCatalog, 'tools' | 'onInstallPlugin'> & { canInstall: boolean }) {
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
            <button className="small-command" disabled={!canInstall} onClick={() => onInstallPlugin(tool.name)}>{t('rightPanel.tools.installTool')}</button>
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

/** Legacy env-var NAME shape. New credentials default to managed values. */
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
  'pagerduty_api_token',
  'pagerduty_webhook_secret',
] as const

function CredentialsPanel({ credentials, onCreateCredential, canWrite }: Pick<RightPanelCatalog, 'credentials' | 'onCreateCredential'> & { canWrite: boolean }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [storage, setStorage] = useState<'managed' | 'environment'>('managed')
  const [secretValue, setSecretValue] = useState('')
  const [secretRef, setSecretRef] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [rotating, setRotating] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
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
  const canAdd = name.trim().length > 0 && (
    storage === 'managed' ? secretValue.length > 0 : CREDENTIAL_ENV_VAR_NAME.test(trimmedRef)
  )

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
        <fieldset className="we-fieldset" disabled={!canWrite || submitting}>
          <label className="field-label" htmlFor="credential-name">{t('rightPanel.credentials.nameLabel')}</label>
          <input id="credential-name" className="text-field" value={name} onChange={event => setName(event.target.value)} />
          <label className="field-label" htmlFor="credential-kind">{t('rightPanel.credentials.kindLabel')}</label>
          <select id="credential-kind" className="text-field" value={kind} onChange={event => setKind(event.target.value)}>
            {CREDENTIAL_KINDS.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <label className="field-label" htmlFor="credential-storage">{t('rightPanel.credentials.storageLabel')}</label>
          <select
            id="credential-storage"
            className="text-field"
            value={storage}
            onChange={event => setStorage(event.target.value as 'managed' | 'environment')}
          >
            <option value="managed">{t('rightPanel.credentials.storage.managed')}</option>
            <option value="environment">{t('rightPanel.credentials.storage.environment')}</option>
          </select>
          <label className="field-label" htmlFor="credential-secret">
            {storage === 'managed' ? t('rightPanel.credentials.valueLabel') : t('rightPanel.credentials.envLabel')}
          </label>
          {storage === 'managed' ? (
            <input
              id="credential-secret"
              type="password"
              autoComplete="new-password"
              className="text-field"
              value={secretValue}
              onChange={event => setSecretValue(event.target.value)}
              placeholder={t('rightPanel.credentials.valuePlaceholder')}
            />
          ) : (
            <input
              id="credential-secret"
              className={`text-field${refInvalid ? ' text-field--error' : ''}`}
              value={secretRef}
              onChange={event => setSecretRef(event.target.value)}
              placeholder={t('rightPanel.credentials.envPlaceholder')}
              aria-invalid={refInvalid}
              aria-describedby={refInvalid ? 'credential-secret-error' : undefined}
            />
          )}
          {storage === 'environment' && refInvalid && (
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
            disabled={!canWrite || !canAdd || submitting}
            onClick={() => {
              setSubmitting(true)
              void onCreateCredential({
                  name: name.trim(),
                  kind,
                  ...(storage === 'managed' ? { secretValue } : { secretRef: trimmedRef }),
                  // Date input gives YYYY-MM-DD; send an ISO instant (UTC midnight).
                  ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
                })
                .then((created) => {
                  if (!created) return
                  setName('')
                  setSecretValue('')
                  setSecretRef('')
                  setExpiresAt('')
                })
                .finally(() => setSubmitting(false))
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
                <span className="mode-pill mode-pill-neutral">
                  {credential.kind} · {credential.storage === 'environment'
                    ? t('rightPanel.credentials.storage.environmentShort')
                    : t('rightPanel.credentials.storage.managedShort')}
                </span>
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
                <button type="button" className="command-button" disabled={!canWrite} onClick={() => setRotating(credential.name)}>
                  {t('credentialRotation.action.rotate')}
                </button>
                <button
                  type="button"
                  className="command-button command-button-danger"
                  disabled={!canWrite || submitting}
                  onClick={() => {
                    if (!window.confirm(t('rightPanel.credentials.revokeConfirm', { name: credential.name }))) return
                    setSubmitting(true)
                    void api(`/credentials/${encodeURIComponent(credential.name)}`, { method: 'DELETE' })
                      .then(() => {
                        bumpPlatformVersion()
                        addToast(t('rightPanel.credentials.revokeDone', { name: credential.name }), 'success')
                      })
                      .catch((error) => {
                        addToast(error instanceof Error ? error.message : t('rightPanel.credentials.revokeFailed'), 'error')
                      })
                      .finally(() => setSubmitting(false))
                  }}
                >
                  {t('rightPanel.credentials.revoke')}
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
