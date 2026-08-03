import { lazy, Suspense, type ReactNode } from 'react'
import type {
  Connection,
  EdgeMouseHandler,
  NodeMouseHandler,
  OnEdgesChange,
  OnNodesChange,
} from '@xyflow/react'
import {
  Activity,
  ChevronRight,
  PlayCircle,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { Layout } from './Layout'
import { BrandMark } from './components/BrandMark'
import { BudgetBlockedBanner } from './components/BudgetBlockedBanner'
import { BuilderSidebar } from './components/BuilderSidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PanelErrorFallback } from './components/PanelErrorFallback'
import { UserMenu } from './components/UserMenu'
import { WorkflowHealthBadge } from './components/WorkflowHealthBadge'
import { WorkflowReadinessBadge } from './components/WorkflowReadinessBadge'
import type { CommandPaletteProps } from './components/CommandPalette'
import type { RecoveryCenterPanelProps } from './components/RecoveryCenterPanel'
import type { RightPanelProps } from './components/RightPanel'
import type { RunInputDialogProps } from './components/RunInputDialog'
import {
  getCanvasVisibility,
  isCanvasTab,
  type ActiveTab,
  type AiHealth,
  type ReadinessResult,
  type RunNode,
  type RunSummary,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from './types'
import {
  getWorkspaceDestination,
  workspaceDestinationForTab,
} from './workspace-locations'
import { DOCS_URL } from './docs-link'
import { I18nNamespaceGate, useT } from './i18n'

const CanvasWorkspace = lazy(() => import('./components/CanvasWorkspace').then((module) => ({
  default: module.CanvasWorkspace,
})))
const RunObservationWorkspace = lazy(() => import('./components/CanvasWorkspace').then((module) => ({
  default: module.RunObservationWorkspace,
})))
const RecoveryCenterPanel = lazy(() => import('./components/RecoveryCenterPanel').then((module) => ({
  default: module.RecoveryCenterPanel,
})))
const RightPanel = lazy(() => import('./components/RightPanel').then((module) => ({
  default: module.RightPanel,
})))
const RunInputDialog = lazy(() => import('./components/RunInputDialog').then((module) => ({
  default: module.RunInputDialog,
})))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((module) => ({
  default: module.CommandPalette,
})))
const SnippetInsertMenu = lazy(() => import('./components/SnippetInsertMenu').then((module) => ({
  default: module.SnippetInsertMenu,
})))
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then((module) => ({
  default: module.ShortcutsModal,
})))

type WorkspaceEnvironment = 'sandbox' | 'production'
type RecoveryPosture = 'blocked' | 'attention' | 'clear'

type CanvasModel = {
  activated: boolean
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  onNodesChange: OnNodesChange<WorkflowGraphNode>
  onEdgesChange: OnEdgesChange<WorkflowGraphEdge>
  onConnect: (connection: Connection) => void
  onNodeClick: NodeMouseHandler<WorkflowGraphNode>
  onEdgeClick: EdgeMouseHandler<WorkflowGraphEdge>
  onAddNode: (type: string, position?: { x: number; y: number }) => void
  readOnly: boolean
  workflowId: string
  viewportWorkflowId?: string
}

type HeaderModel = {
  environment: WorkspaceEnvironment
  organizationLabel: string
  workflowName: string
  workflowSaved: boolean
  workflowId: string
  workflowVersion: number | null
  workflowRunsCount: number
  aiHealth: AiHealth | null
  streamStatus: 'idle' | 'connecting' | 'connected' | 'closed' | 'error'
  recoveryPosture: RecoveryPosture
  recoveryBlockerCount: number
  openRecoveryCount: number
  activeRunCount: number
}

type AppWorkspaceProps = {
  activeTab: ActiveTab
  permissions: readonly string[]
  header: HeaderModel
  rightPanel: Omit<RightPanelProps, 'tab' | 'permissions'>
  canvas: CanvasModel
  home: RecoveryCenterPanelProps
  observedRun?: RunSummary
  runNodes: RunNode[]
  runInput: (Omit<RunInputDialogProps, 'onCancel'> & { onCancel: () => void }) | null
  palette: CommandPaletteProps & { visible: boolean }
  shortcutsOpen: boolean
  snippetMenuOpen: boolean
  onWorkflowNameChange: (name: string) => void
  onValidate: () => unknown
  onSave: () => unknown
  onStart: () => unknown
  onOpenTab: (tab: ActiveTab) => void
  onOpenHelp: () => void
  onOpenRecovery: () => void
  onReadinessResult: (result: ReadinessResult | null) => void
  onOpenPalette: () => void
  onCloseShortcuts: () => void
  onCloseSnippetMenu: () => void
}

function WorkingFallback() {
  const { t } = useT()
  return <div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>
}

function WorkspaceContent(props: AppWorkspaceProps) {
  const { t } = useT()
  const {
    activeTab,
    permissions,
    header,
    canvas,
    home,
    observedRun,
    runNodes,
  } = props
  const authoringMode = isCanvasTab(activeTab)
  const destination = getWorkspaceDestination(workspaceDestinationForTab(activeTab))
  const environmentLabel = header.environment === 'production'
    ? t('topbar.env.production')
    : t('topbar.env.sandbox')
  const canWriteWorkflows = permissions.includes('workflows.write')
  const canReadRecovery = permissions.includes('recovery.read')
  const canReadDlq = permissions.includes('dlq.read')
  const canReadRuns = permissions.includes('runs.read')

  const rightPanelElement = (
    <ErrorBoundary
      resetKey={`workspace:${activeTab}`}
      logTag={`workspace:${activeTab}`}
      fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
    >
      <Suspense fallback={<WorkingFallback />}>
        <RightPanel
          {...props.rightPanel}
          tab={activeTab}
          permissions={permissions}
        />
      </Suspense>
    </ErrorBoundary>
  )

  const main: ReactNode = (() => {
    const visibility = getCanvasVisibility(activeTab, canvas.activated)
    if (activeTab === 'home') {
      return (
        <ErrorBoundary
          resetKey={activeTab}
          logTag="panel:home"
          fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
        >
          <Suspense fallback={<WorkingFallback />}>
            <RecoveryCenterPanel {...home} />
          </Suspense>
        </ErrorBoundary>
      )
    }

    return (
      <>
        {visibility.mounted && (
          <div
            className="workspace-canvas-wrapper"
            data-canvas-visible={visibility.visible ? 'true' : 'false'}
            data-testid="workspace-canvas-wrapper"
          >
            <Suspense fallback={<WorkingFallback />}>
              <CanvasWorkspace
                key={canvas.workflowId}
                nodes={canvas.nodes}
                edges={canvas.edges}
                onNodesChange={canvas.onNodesChange}
                onEdgesChange={canvas.onEdgesChange}
                onConnect={canvas.onConnect}
                onNodeClick={canvas.onNodeClick}
                onEdgeClick={canvas.onEdgeClick}
                onAddNode={canvas.onAddNode}
                readOnly={canvas.readOnly}
                viewportWorkflowId={canvas.viewportWorkflowId}
                active={visibility.visible}
              />
            </Suspense>
          </div>
        )}
        {visibility.contextualSlot && (
          (activeTab === 'runs' || activeTab === 'reasoning') && observedRun ? (
            <Suspense fallback={<WorkingFallback />}>
              <RunObservationWorkspace
                key={observedRun.id}
                run={observedRun}
                runNodes={runNodes}
                panel={rightPanelElement}
              />
            </Suspense>
          ) : (
            <div data-layout="contextual">{rightPanelElement}</div>
          )
        )}
      </>
    )
  })()

  const workspace = (
    <Layout
      authoring={authoringMode}
      header={
        <>
          <div className="top-bar-left">
            <BrandMark size={32} />
            <nav className="top-bar-breadcrumb" aria-label={t('layout.workflowStatus')}>
              <span>{header.organizationLabel}</span>
              <ChevronRight size={12} aria-hidden="true" />
              <b>{authoringMode ? header.workflowName : t(destination.labelKey)}</b>
              {authoringMode && (
                <span className={`top-bar-env top-bar-env--${header.environment}`}>
                  {environmentLabel}
                </span>
              )}
            </nav>
          </div>
          <div className="top-bar-right">
            <div className="top-bar-pill-group">
              {activeTab === 'inspector' && canWriteWorkflows && (
                <WorkflowReadinessBadge
                  onOpenProblems={() => document
                    .querySelector<HTMLButtonElement>('.authoring-scope-nav button:last-of-type')
                    ?.click()}
                  onResult={props.onReadinessResult}
                />
              )}
              {authoringMode && permissions.includes('workflows.read') && (
                <WorkflowHealthBadge workflowId={header.workflowSaved ? header.workflowId : undefined} />
              )}
            </div>
            {canReadRecovery && (
              <button
                type="button"
                className={`top-bar-cta top-bar-cta--${header.recoveryPosture}`}
                onClick={() => (
                  header.recoveryPosture === 'clear'
                    ? props.onOpenTab('home')
                    : props.onOpenRecovery()
                )}
                aria-label={
                  header.recoveryPosture === 'blocked'
                    ? t('topbar.blockerAria', { count: header.recoveryBlockerCount })
                    : header.recoveryPosture === 'attention'
                      ? t('topbar.recoverAria', { count: header.openRecoveryCount })
                      : t('topbar.allClearAria')
                }
              >
                {header.recoveryPosture === 'clear' ? (
                  <>
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>{t('topbar.allClear')}</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert size={13} aria-hidden="true" />
                    <span>
                      {header.recoveryPosture === 'blocked'
                        ? t('topbar.blocker', { count: header.recoveryBlockerCount })
                        : t('topbar.recover', { count: header.openRecoveryCount })}
                    </span>
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              className="top-bar-cmdk"
              onClick={props.onOpenPalette}
              aria-label={t('topbar.cmdkAria')}
            >
              <Search size={13} aria-hidden="true" />
              <span>{t('topbar.cmdkLabel')}</span>
              <kbd>⌘K</kbd>
            </button>
            <UserMenu
              aiHealth={header.aiHealth}
              docsUrl={DOCS_URL}
              onOpenTab={props.onOpenTab}
              onOpenShortcuts={props.onOpenHelp}
            />
          </div>
        </>
      }
      sidebar={
        <BuilderSidebar
          activeTab={activeTab}
          aiHealth={header.aiHealth}
          workflowName={header.workflowName}
          streamStatus={header.streamStatus}
          workflowEnv={header.environment}
          workflowVersion={header.workflowVersion}
          workflowRunsCount={header.workflowRunsCount}
          permissions={permissions}
          onWorkflowNameChange={props.onWorkflowNameChange}
          onValidate={() => { void props.onValidate() }}
          onSave={() => { void props.onSave() }}
          onOpenTab={props.onOpenTab}
          onOpenHelp={props.onOpenHelp}
          onStart={() => { void props.onStart() }}
        />
      }
      main={main}
      panel={authoringMode ? rightPanelElement : null}
      overlay={
        <Suspense fallback={null}>
          <BudgetBlockedBanner onOpenTab={props.onOpenTab} />
          {props.runInput && <RunInputDialog {...props.runInput} />}
          {props.palette.visible && <CommandPalette {...props.palette} />}
          {props.shortcutsOpen && (
            <ShortcutsModal
              open
              onClose={props.onCloseShortcuts}
              permissions={permissions}
            />
          )}
          {props.snippetMenuOpen && (
            <SnippetInsertMenu open onClose={props.onCloseSnippetMenu} />
          )}
        </Suspense>
      }
      statusBar={
        <>
          <div className="bottom-status-bar__group">
            <span className={`bottom-status-bar__item ${header.streamStatus === 'connected' ? 'bottom-status-bar__item--live' : ''}`}>
              <span className="bottom-status-bar__dot" />
              <span>
                {header.streamStatus === 'connected'
                  ? t('statusBar.operatorOnline')
                  : t('statusBar.operatorOffline')}
              </span>
            </span>
            {canReadDlq && (
              <>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
                <span className="bottom-status-bar__item">
                  <Activity size={12} aria-hidden="true" />
                  <span>{t('statusBar.dlq', { dlq: header.openRecoveryCount })}</span>
                </span>
              </>
            )}
            {canReadRuns && (
              <>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
                <span className="bottom-status-bar__item">
                  <PlayCircle size={12} aria-hidden="true" />
                  <span>{t('statusBar.activeRuns', { count: header.activeRunCount })}</span>
                </span>
              </>
            )}
          </div>
          <div className="bottom-status-bar__group bottom-status-bar__group--right">
            {DOCS_URL && (
              <>
                <a
                  className="bottom-status-bar__item"
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="status-bar-docs"
                >
                  {t('statusBar.docs')}
                </a>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
              </>
            )}
            <span className="bottom-status-bar__item">
              {header.organizationLabel} · build <span>{__BUILD_ID__}</span>
            </span>
            <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
            <button
              type="button"
              className="bottom-status-bar__item bottom-status-bar__item--button"
              onClick={props.onOpenHelp}
              aria-label={t('statusBar.shortcuts')}
            >
              <kbd>?</kbd>
              <span>{t('statusBar.shortcuts')}</span>
            </button>
          </div>
        </>
      }
    />
  )

  if (activeTab === 'home') return workspace
  return (
    <Suspense fallback={<div className="boot-screen" role="status"><span>{t('common.working')}</span></div>}>
      <I18nNamespaceGate namespace="workspace">
        {workspace}
      </I18nNamespaceGate>
    </Suspense>
  )
}

export function AppWorkspace(props: AppWorkspaceProps) {
  return <WorkspaceContent {...props} />
}
