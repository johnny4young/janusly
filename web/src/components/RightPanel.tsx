/**
 * Right-side workspace panel — the tab-aware router that switches between
 * AI Studio, Inspector, Templates, Tools, Connections, the unified Runs
 * workspace, Operations, Members, and the expert full-view tabs.
 *
 * Heavier tabs live in sibling files (`InspectorPanel.tsx`, `RunWorkspace.tsx`,
 * `UsageSummaryCard.tsx`, `QuickConfigEditor.tsx`, `McpToolConfigField.tsx`,
 * `AiUsageFooter.tsx`). The thinner Templates tab stays here because it's small
 * and single-purpose. `PanelChrome`
 * + `EmptyView` live in the sibling `panel-primitives.tsx` file so the
 * extracted sub-panels reuse them without a circular `./RightPanel` import.
 *
 * Used by `App.tsx` (top-level routing on `tab`).
 *
 * Invariants:
 * - Mutations that invalidate server data call `bumpPlatformVersion()` so
 *   sibling panels refetch (AGENTS.md cross-panel reactivity).
 * - Web deps locked to the AGENTS.md whitelist plus
 *   `@/lib/status` for zero-dep lifecycle guards. Don't add
 *   radix / cva / clsx / tailwind-merge / shadcn here.
 */

import { lazy, memo, Suspense, useCallback, useMemo, useState } from 'react'
import { Workflow } from 'lucide-react'
import { isCanvasTab } from '../types'
import type { ActiveTab, AiAuthoringActionRequest, AiHealth, AiMode, AuthoringCapabilityCatalog, Credential, RunEvent, RunNode, RunSummary, SavedWorkflow, SolutionPackPublic, Template, ToolSchema, WorkflowBriefCompilation, WorkflowDefinition, WorkflowImprovementResult, WorkflowImprovementSuggestion, WorkflowIntentBrief, WorkflowProposalApplyOutcome, WorkflowProposalResponse } from '../types'
import type { DeadLetter } from './dead-letter-types'
import type { AuthoringPanelModel } from './AuthoringPanel'
import { panelLoaders, preloadPanel } from './panel-loaders'
import { EmptyView, PanelChrome, PanelSearch } from './panel-primitives'
import { ErrorBoundary } from './ErrorBoundary'
import { PanelErrorFallback } from './PanelErrorFallback'
import { RunEventsPicker } from './RunEventsPicker'
import { WorkspaceSectionNav } from './WorkspaceSectionNav'
export { WorkspaceSectionNav }
// Every tab panel is code-split out of the eager shell: each renders only when
// the operator navigates to its tab, behind the shared <Suspense> below. AI
// Studio and the Inspector (node/edge config) are lazy too — their chunk is
// requested by the same importers as the section navigation's hover/focus
// preload. Chunk grouping lives in vite.config.ts; shared dependencies can
// load a chunk before its lazy component mounts.

const MultiAgentTimeline = lazy(() => panelLoaders.multiAgent().then((m) => ({ default: m.MultiAgentTimeline })))
const WorkflowsDashboard = lazy(() => panelLoaders.workflows().then((m) => ({ default: m.WorkflowsDashboard })))
const MembersPanel = lazy(() => panelLoaders.members().then((m) => ({ default: m.MembersPanel })))
const ConnectionsPanel = lazy(() => panelLoaders.credentials().then((m) => ({ default: m.ConnectionsPanel })))
const ToolsPanel = lazy(() => panelLoaders.marketplace().then((m) => ({ default: m.ToolsPanel })))
const SolutionPacksPanel = lazy(() => panelLoaders.packs().then((m) => ({ default: m.SolutionPacksPanel })))
const RecipeCatalog = lazy(() => panelLoaders.templates().then((m) => ({ default: m.RecipeCatalog })))
const OperationsPage = lazy(() => panelLoaders.operations().then((m) => ({ default: m.OperationsPage })))
const ExperimentsPanel = lazy(() => panelLoaders.experiments().then((m) => ({ default: m.ExperimentsPanel })))
const ActivityWorkspace = lazy(() => panelLoaders.recover().then((m) => ({ default: m.ActivityWorkspace })))
const RunsPanel = lazy(() => panelLoaders.runs().then((m) => ({ default: m.RunsPanel })))
const RecoveryCasePanel = lazy(() => panelLoaders.recoveryCase().then((m) => ({ default: m.RecoveryCasePanel })))
const ReasoningPanel = lazy(() => panelLoaders.reasoning().then((m) => ({ default: m.ReasoningPanel })))
const ReportsPanel = lazy(() => panelLoaders.reports().then((m) => ({ default: m.ReportsPanel })))
const AiStudioPanel = lazy(() => panelLoaders['ai-studio']().then((m) => ({ default: m.AiStudioPanel })))
const AuthoringPanel = lazy(() => panelLoaders.inspector().then((m) => ({ default: m.AuthoringPanel })))
import { api, contractApi } from '../api'
import { useWorkflowStore } from '../store'
import { workspaceDestinationForTab } from '../workspace-locations'
import { tTemplateCategory, tTemplateDescription, tTemplateName, useT } from '../i18n'
import type { WorkflowCreationMode } from './WorkflowsDashboard'
import { isGetRunUsageResponse } from '../lib/api-guards/operations/GetRunUsage'

export type RightPanelAuthoring = AuthoringPanelModel & {
  aiHealth: AiHealth | null
  aiActionRequest: AiAuthoringActionRequest | null
  onLoadAuthoringCapabilities: (signal?: AbortSignal) => Promise<AuthoringCapabilityCatalog>
  onCompileWorkflowBrief: (prompt: string) => Promise<WorkflowBriefCompilation>
  onProposeWorkflow: (brief: WorkflowIntentBrief, catalogVersion: string, sourcePrompt: string) => Promise<WorkflowProposalResponse>
  onApplyWorkflowProposal: (proposal: WorkflowProposalResponse) => Promise<WorkflowProposalApplyOutcome>
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
  credentialsKnown: boolean
  workflows: SavedWorkflow[]
  onOpenWorkflow: (id: string) => void
  onOpenWorkflowVersion: (workflowId: string, versionId: string, targetTab?: ActiveTab) => Promise<boolean>
  onCreateWorkflow: (mode: WorkflowCreationMode) => void
  onUseTemplate: (workflow: WorkflowDefinition) => void
  onInstallPlugin: (pluginId: string) => Promise<boolean>
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
  onRevokeCredential: (name: string) => Promise<boolean>
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
  onOpenRun: (id: string, targetTab?: ActiveTab) => void | Promise<void>
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
  onResolveDeadLetter: (id: string, reason: string) => boolean | Promise<boolean> | undefined
}

export type RightPanelNavigation = {
  onOpenTab: (tab: ActiveTab) => void
  onOpenAiAction: (action: AiAuthoringActionRequest['action'], prompt?: string) => void
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
// Memoized: the shell re-renders on every store tick, and the panel's props
// are stable references between ticks that do not concern it.
export const RightPanel = memo(function RightPanel(props: RightPanelProps) {
  const { t } = useT()
  const destination = workspaceDestinationForTab(props.tab)
  const openRecoveryCount = useMemo(
    () => props.execution.deadLetters.filter((deadLetter) => deadLetter.status === 'open').length,
    [props.execution.deadLetters],
  )
  return (
    <div
      className="workspace-panel-stack"
      data-destination={destination}
    >
      {/* The Build layout shows this navigation in the top bar. */}
      {!isCanvasTab(props.tab) && (
        <WorkspaceSectionNav
          activeTab={props.tab}
          permissions={props.permissions}
          openRecoveryCount={openRecoveryCount}
          onOpenTab={props.navigation.onOpenTab}
        />
      )}
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
})

/** Tab→panel router — picks the inner panel component for the active tab. The
 *  'home' tab is intentionally handled by `App.tsx` at the layout level (panel
 *  slot is null, Recovery Center goes in the main area so it has hero-page real
 *  estate); this dispatcher never receives it. */
function RightPanelRouter(props: RightPanelProps) {
  const { t } = useT()
  const { authoring, catalog, execution, navigation } = props
  const can = (permission: string) => props.permissions === undefined || props.permissions.includes(permission)
  const loadRunUsage = useCallback((runId: string, signal: AbortSignal) =>
    contractApi('GET /run/usage', `/run/usage?runId=${encodeURIComponent(runId)}`, undefined, { signal, guard: isGetRunUsageResponse }), [])
  const replayDecision = useCallback((eventId: string, nodeId: string, signal: AbortSignal) => {
    if (!execution.activeRunId) return Promise.resolve(null)
    return api(`/causal?runId=${encodeURIComponent(execution.activeRunId)}&eventId=${encodeURIComponent(eventId)}&nodeId=${encodeURIComponent(nodeId)}`, { signal })
  }, [execution.activeRunId])
  const { onOpenRun } = execution
  const openRunEvents = useCallback((id: string) => void onOpenRun(id, 'reasoning'), [onOpenRun])
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
  if (props.tab === 'ai-studio') return (
    <AiStudioPanel
      health={authoring.aiHealth}
      workflowName={authoring.currentWorkflowName}
      onLoadAuthoringCapabilities={authoring.onLoadAuthoringCapabilities}
      onCompileWorkflowBrief={authoring.onCompileWorkflowBrief}
      onProposeWorkflow={authoring.onProposeWorkflow}
      onApplyWorkflowProposal={authoring.onApplyWorkflowProposal}
      onExplainWorkflow={authoring.onExplainWorkflow}
      onReviewWorkflow={authoring.onReviewWorkflow}
      actionRequest={authoring.aiActionRequest}
      onSuggestWorkflowImprovement={authoring.onSuggestWorkflowImprovement}
      onApplyWorkflowImprovement={authoring.onApplyWorkflowImprovement}
      onViewCanvas={() => {
        const canvas = document.querySelector<HTMLElement>('[data-testid="workflow-canvas"]')
        canvas?.scrollIntoView({ block: 'nearest' })
        canvas?.focus({ preventScroll: true })
      }}
      onOpenRuns={() => navigation.onOpenTab('runs')}
      onOpenTemplates={() => navigation.onOpenTab('templates')}
    />
  )
  if (props.tab === 'multiAgent') return (
    <PanelChrome title={t('rightPanel.multiAgent.title')} description={t('rightPanel.multiAgent.description')}>
      <MultiAgentTimeline events={execution.events} eventsHasMore={execution.eventsHasMore} onLoadOlderEvents={execution.onLoadOlderEvents} />
    </PanelChrome>
  )
  if (props.tab === 'reports') return (
    <PanelChrome title={t('workspace.section.reports.label')} description={t('workspace.section.reports.helper')}>
      <ReportsPanel
        canReadDeadLetters={can('dlq.read')}
        canReadReports={can('reports.read')}
        canReadRuns={can('runs.read')}
        onOpenTab={navigation.onOpenTab}
        onOpenRun={onOpenRun}
      />
    </PanelChrome>
  )
  if (props.tab === 'workflows') return (
    <PanelChrome title={t('rightPanel.workflows.title')} description={t('rightPanel.workflows.description')}>
      <WorkflowsDashboard
        onOpen={catalog.onOpenWorkflow}
        onCreate={catalog.onCreateWorkflow}
        canWrite={can('workflows.write')}
      />
    </PanelChrome>
  )
  if (props.tab === 'operations') return (
    <OperationsPage
      permissions={props.permissions}
      aiHealth={authoring.aiHealth}
      onOpenTab={navigation.onOpenTab}
    />
  )
  if (props.tab === 'recoveryCase') return (
    <RecoveryCasePanel
      caseId={navigation.activeRecoveryCaseId}
      canResolve={can('recovery.write')}
      canInspectWorkflow={can('workflows.read')}
      canAuthorWorkflow={can('workflows.read') && can('workflows.write') && can('ai.write')}
      onBack={() => navigation.onOpenTab('home')}
      onOpenRun={execution.onOpenRun}
      onOpenWorkflowVersion={catalog.onOpenWorkflowVersion}
      onOpenAiAuthoring={(prompt) => navigation.onOpenAiAction('generate', prompt)}
      onResolved={execution.onRefreshPlatform}
    />
  )
  if (props.tab === 'experiments') return (
    <PanelChrome title={t('rightPanel.experiments.title')} description={t('rightPanel.experiments.description')}>
      <ExperimentsPanel />
    </PanelChrome>
  )
  if (props.tab === 'members') return (
    <PanelChrome title={t('rightPanel.members.title')} description={t('rightPanel.members.description')}>
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
      credentialsKnown={catalog.credentialsKnown}
      onUseTemplate={catalog.onUseTemplate}
      onInstallPack={catalog.onInstallPack}
      onSampleRunPack={catalog.onSampleRunPack}
      onInjectPackFailure={catalog.onInjectPackFailure}
      onCreateCredential={can('credentials.write') ? catalog.onCreateCredential : undefined}
      canUse={can('workflows.write')}
      canInstallPacks={can('packs.install')}
    />
  )
  if (props.tab === 'packs') return (
    <SolutionPacksPanel
      packs={catalog.solutionPacks}
      credentials={catalog.credentials}
      credentialsKnown={catalog.credentialsKnown}
      onInstall={catalog.onInstallPack}
      onSampleRun={catalog.onSampleRunPack}
      onInjectFailure={catalog.onInjectPackFailure}
      onCreateCredential={can('credentials.write') ? catalog.onCreateCredential : undefined}
      canInstall={can('packs.install')}
    />
  )
  if (props.tab === 'marketplace') return (
    <ToolsPanel tools={catalog.tools} onInstallPlugin={catalog.onInstallPlugin} canInstall={can('workflows.write')} />
  )
  if (props.tab === 'credentials') return (
    <ConnectionsPanel
      credentials={catalog.credentials}
      workflows={catalog.workflows}
      onCreateCredential={catalog.onCreateCredential}
      onRevokeCredential={catalog.onRevokeCredential}
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
    <PanelChrome title={t('rightPanel.reasoning.title')} description={t('rightPanel.reasoning.description')}>
      <RunEventsPicker
        runs={execution.runs}
        activeRunId={execution.activeRunId}
        onSelectRun={openRunEvents}
      />
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
  credentialsKnown,
  onUseTemplate,
  onInstallPack,
  onSampleRunPack,
  onInjectPackFailure,
  onCreateCredential,
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
  credentialsKnown?: boolean
  onCreateCredential?: RightPanelCatalog['onCreateCredential']
  canUse?: boolean
  canInstallPacks?: boolean
}) {
  const { t } = useT()
  const setActiveTab = useWorkflowStore(state => state.setActiveTab)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'recipes' | 'packs'>('recipes')
  const [category, setCategory] = useState('all')
  const activeView = templates.length === 0 ? 'packs' : view
  const q = query.trim().toLowerCase()
  const filtered = q
    ? templates.filter(template =>
      `${tTemplateName(template)} ${tTemplateDescription(template)} ${tTemplateCategory(template)}`.toLowerCase().includes(q),
    )
    : templates
  // Same fields SolutionPacksPanel searches, so a search can point at the other view.
  const matchingPacks = q
    ? solutionPacks.filter(pack => [
      t(`packs.${pack.id}.name`, { defaultValue: pack.name }),
      t(`packs.${pack.id}.description`, { defaultValue: pack.description }),
      t(`packs.category.${pack.category}`, { defaultValue: pack.category }),
      ...pack.failureFixtures.flatMap(fixture => [
        t(`packs.${pack.id}.drills.${fixture.id}.label`, { defaultValue: fixture.label }),
        t(`packs.${pack.id}.drills.${fixture.id}.description`, { defaultValue: fixture.description }),
        t(`packs.drill.mode.${fixture.failureMode}`, { defaultValue: fixture.failureMode }),
      ]),
    ].join(' ').toLowerCase().includes(q))
    : solutionPacks

  return (
    <PanelChrome title={t('rightPanel.templates.title')} description={t('rightPanel.templates.description')}>
      {templates.length === 0 && solutionPacks.length === 0 ? (
        <div className="panel-list">
          <EmptyView
            icon={<Workflow size={22} />}
            title={t('rightPanel.templates.empty.title')}
            body={t('rightPanel.templates.empty.body')}
            cta={{ label: t('rightPanel.templates.empty.cta'), onClick: () => setActiveTab('ai-studio') }}
          />
        </div>
      ) : (
        <>
          <div className="template-catalog-toolbar">
            <PanelSearch value={query} onChange={setQuery} placeholder={t('rightPanel.templates.searchPlaceholder')} />
            <div className="we-seg" role="group" aria-label={t('rightPanel.templates.viewAria')}>
              <button type="button" aria-pressed={activeView === 'recipes'} onClick={() => setView('recipes')} data-testid="template-view-recipes">
                {t('rightPanel.templates.recipes')} <strong>{filtered.length}</strong>
              </button>
              <button
                type="button"
                aria-pressed={activeView === 'packs'}
                onClick={() => setView('packs')}
                onPointerEnter={() => preloadPanel('packs')}
                onFocus={() => preloadPanel('packs')}
                data-testid="template-view-packs"
              >
                {t('workspace.section.packs.label')} <strong>{matchingPacks.length}</strong>
              </button>
            </div>
          </div>
          {activeView === 'recipes' && (
            <RecipeCatalog
              templates={templates}
              matches={filtered}
              category={category}
              onCategoryChange={setCategory}
              canUse={canUse}
              onUseTemplate={onUseTemplate}
            />
          )}
          {activeView === 'packs' && <section className="template-catalog-section">
            <SolutionPacksPanel
              embedded
              showSearch={false}
              query={query}
              onQueryChange={setQuery}
              packs={solutionPacks}
              credentials={credentials}
              credentialsKnown={credentialsKnown}
              onInstall={onInstallPack}
              onSampleRun={onSampleRunPack}
              onInjectFailure={onInjectPackFailure}
              onCreateCredential={onCreateCredential}
              canInstall={canInstallPacks}
            />
          </section>}
        </>
      )}
    </PanelChrome>
  )
}
