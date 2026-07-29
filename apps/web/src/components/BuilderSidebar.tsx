/**
 * Persistent task-space navigator.
 *
 * The sidebar owns global navigation and compact workflow actions only. Step
 * discovery belongs to the canvas' single searchable Add step control.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  CheckCircle2,
  HelpCircle,
  Home,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Save,
  Search,
  Settings2,
  Sparkles,
  Workflow,
} from 'lucide-react'

import { MOBILE_WORKSPACE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { useT } from '../i18n'
import { useWorkflowStore } from '../store'
import type { ActiveTab, AiHealth } from '../types'
import {
  WORKSPACE_DESTINATION_DEFINITIONS,
  canOpenWorkspaceDestination,
  resolveWorkspaceDestinationTarget,
  workspaceDestinationForTab,
  type WorkspaceDestination,
} from '../workspace-locations'

type BuilderSidebarProps = {
  workflowName: string
  activeTab: ActiveTab
  streamStatus: string
  aiHealth: AiHealth | null
  workflowEnv?: 'sandbox' | 'production'
  workflowVersion?: number | null
  workflowRunsCount?: number | null
  permissions: readonly string[]
  onWorkflowNameChange: (name: string) => void
  onValidate: () => void | Promise<void>
  onSave: () => void | Promise<void>
  onStart: () => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
  onOpenHelp: () => void
}

const STORAGE_KEY = 'janusly:sidebar:state'

const DESTINATION_ICONS: Record<WorkspaceDestination, ReactNode> = {
  home: <Home size={14} />,
  workflows: <Workflow size={14} />,
  activity: <Activity size={14} />,
  settings: <Settings2 size={14} />,
}

function loadCollapsedState(): boolean {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as { collapsed?: unknown }
    return parsed.collapsed === true
  } catch {
    return false
  }
}

function persistCollapsedState(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed }))
  } catch {
    // Storage is an optional convenience; navigation remains functional.
  }
}

export function BuilderSidebar({
  activeTab,
  aiHealth,
  workflowName,
  streamStatus,
  workflowEnv = 'sandbox',
  workflowVersion = null,
  workflowRunsCount = null,
  permissions,
  onValidate,
  onSave,
  onStart,
  onOpenTab,
  onOpenHelp,
  onWorkflowNameChange,
}: BuilderSidebarProps) {
  const { t } = useT()
  const isMobile = useMediaQuery(MOBILE_WORKSPACE_QUERY)
  const currentWorkflowSaved = useWorkflowStore((state) => state.currentWorkflowSaved)
  const [busyAction, setBusyAction] = useState<'validate' | 'save' | 'run' | null>(null)
  const busyActionRef = useRef<typeof busyAction>(null)
  const [collapsed, setCollapsed] = useState(loadCollapsedState)
  const [searchQuery, setSearchQuery] = useState('')
  const visuallyCollapsed = collapsed && !isMobile
  const authoringMode = activeTab === 'copilot' || activeTab === 'inspector'
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()

  useEffect(() => {
    persistCollapsedState(collapsed)
  }, [collapsed])

  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = visuallyCollapsed ? 'true' : 'false'
    return () => { document.documentElement.dataset.sidebarCollapsed = 'false' }
  }, [visuallyCollapsed])

  const filteredDestinations = useMemo(() => {
    const allowed = WORKSPACE_DESTINATION_DEFINITIONS.filter((destination) =>
      canOpenWorkspaceDestination(destination.id, permissions))
    if (!normalizedQuery) return allowed
    return allowed.filter((destination) =>
      `${t(destination.labelKey)} ${t(destination.helperKey)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery))
  }, [normalizedQuery, permissions, t])

  const runAction = async (
    kind: 'validate' | 'save' | 'run',
    action: () => void | Promise<void>,
  ) => {
    if (busyActionRef.current) return
    busyActionRef.current = kind
    setBusyAction(kind)
    try {
      await action()
    } finally {
      busyActionRef.current = null
      setBusyAction(null)
    }
  }

  const aiModeLabel = aiHealth?.enabled ? t('sidebar.aiMode.connected') : t('sidebar.aiMode.localMode')
  const aiSubline = aiHealth?.enabled
    ? t('sidebar.aiMode.tagline', { model: aiHealth.model })
    : t('sidebar.aiMode.copyLocal')
  const envLabel = workflowEnv === 'production'
    ? t('sidebar.workflow.envProduction')
    : t('sidebar.workflow.envSandbox')
  const connectionLabel = streamStatus === 'connected' ? t('sidebar.footer.connected') : streamStatus

  return (
    <aside className="builder-sidebar" data-collapsed={visuallyCollapsed ? 'true' : 'false'}>
      {authoringMode && (
        <div className={`sb-workflow ${workflowEnv === 'production' ? 'sb-workflow--prod' : 'sb-workflow--sandbox'}`}>
          <div className="sb-workflow__top">
            <label className="sb-workflow__name" aria-label={t('sidebar.workflow.rename')}>
              <span className="sb-workflow__name-ic" aria-hidden="true"><Workflow size={13} /></span>
              <input
                type="text"
                value={workflowName}
                onChange={(event) => onWorkflowNameChange(event.target.value)}
                className="sb-workflow__name-input"
                aria-label={t('sidebar.field.name')}
                disabled={!permissions.includes('workflows.write')}
              />
              <span className="sb-workflow__name-edit" aria-hidden="true"><Pencil size={11} /></span>
            </label>
            <span className={`sb-env sb-env--${workflowEnv}`}>{envLabel}</span>
          </div>
          <div className="sb-workflow__meta">
            <span className={`sb-workflow__dot sb-workflow__dot--${streamStatus}`} />
            <span>
              {t(streamStatus === 'connected'
                ? 'sidebar.workflow.status.idle'
                : `sidebar.streamStatus.${streamStatus}` as never)}
            </span>
            {workflowVersion !== null && (
              <>
                <span className="sb-workflow__sep" aria-hidden="true">·</span>
                <span><b>v{workflowVersion}</b> {t('sidebar.workflow.meta.version')}</span>
              </>
            )}
            {workflowRunsCount !== null && (
              <>
                <span className="sb-workflow__sep" aria-hidden="true">·</span>
                <span><b>{workflowRunsCount}</b> {t('sidebar.workflow.meta.runs', { count: workflowRunsCount })}</span>
              </>
            )}
            {!currentWorkflowSaved && (
              <>
                <span className="sb-workflow__sep" aria-hidden="true">·</span>
                <span className="sb-workflow__unsaved" data-testid="sidebar-unsaved">
                  {t('sidebar.workflow.meta.unsaved')}
                </span>
              </>
            )}
          </div>
          <div className="sb-workflow__acts">
            <button
              className="sb-workflow__ghost"
              type="button"
              onClick={() => { void runAction('validate', onValidate) }}
              disabled={busyAction !== null || !permissions.includes('workflows.write')}
              aria-busy={busyAction === 'validate'}
              title={t('sidebar.action.validate')}
              aria-label={t('sidebar.action.validate')}
            >
              {busyAction === 'validate'
                ? <Loader2 size={13} className="we-spin" aria-hidden="true" />
                : <CheckCircle2 size={13} aria-hidden="true" />}
            </button>
            <button
              className="sb-workflow__ghost"
              type="button"
              onClick={() => { void runAction('save', onSave) }}
              disabled={busyAction !== null || !permissions.includes('workflows.write')}
              aria-busy={busyAction === 'save'}
              title={t('sidebar.action.save')}
              aria-label={t('sidebar.action.save')}
            >
              {busyAction === 'save'
                ? <Loader2 size={13} className="we-spin" aria-hidden="true" />
                : <Save size={13} aria-hidden="true" />}
            </button>
            <button
              className="sb-workflow__run"
              type="button"
              onClick={() => { void runAction('run', onStart) }}
              disabled={busyAction !== null || !permissions.includes('runs.start')}
              aria-busy={busyAction === 'run'}
            >
              {busyAction === 'run'
                ? <Loader2 size={12} className="we-spin" aria-hidden="true" />
                : <Play size={12} aria-hidden="true" />}
              <span>{busyAction === 'run' ? t('sidebar.action.running') : t('sidebar.action.run')}</span>
            </button>
          </div>
        </div>
      )}

      {authoringMode && permissions.includes('ai.write') && (
        <button
          className="sb-ai-strip"
          type="button"
          onClick={() => onOpenTab('copilot')}
          data-mobile-nav-close="true"
          title={aiHealth?.enabled ? t('sidebar.aiMode.liveHint') : t('sidebar.aiMode.localHint')}
        >
          <span className="sb-ai-strip__ic" aria-hidden="true"><Sparkles size={12} /></span>
          <span className="sb-ai-strip__body">
            <strong>{aiModeLabel}</strong>
            <small>{aiSubline}</small>
          </span>
          <span className={`sb-ai-strip__pill sb-ai-strip__pill--${aiHealth?.enabled ? 'live' : 'local'}`}>
            {aiHealth?.enabled ? t('sidebar.aiMode.live') : t('sidebar.aiMode.local')}
          </span>
        </button>
      )}

      <label className="sb-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('sidebar.search.navigationPlaceholder')}
          aria-label={t('sidebar.search.navigationPlaceholder')}
          data-shortcut="sidebar-search"
        />
        <kbd>/</kbd>
      </label>

      <nav className="sb-groups" aria-label={t('sidebar.workspaceViews')}>
        <div className="sb-group sb-group--open">
          <div className="sb-group__head sb-group__head--static">
            <span className="sb-group__head-label">{t('sidebar.group.workspace')}</span>
            <span className="sb-group__count">{filteredDestinations.length}</span>
          </div>
          <ul className="sb-group__list">
            {filteredDestinations.map((destination) => {
              const label = t(destination.labelKey)
              const helper = t(destination.helperKey)
              const active = workspaceDestinationForTab(activeTab) === destination.id
              const target = resolveWorkspaceDestinationTarget(destination.id, permissions)
              return (
                <li key={destination.id}>
                  <button
                    className={`sb-view ${active ? 'sb-view--on' : ''}`}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    aria-label={label}
                    onClick={() => {
                      if (target) onOpenTab(target)
                    }}
                    data-mobile-nav-close="true"
                    title={`${label} — ${helper}`}
                  >
                    <span className="sb-view__ic" aria-hidden="true">{DESTINATION_ICONS[destination.id]}</span>
                    <span className="sb-view__label">{label}</span>
                    <span className="sb-view__meta">{destination.shortcut}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>

      <div className="sb-footer">
        <span className={`sb-footer__live sb-footer__live--${streamStatus}`}>
          <span className="sb-footer__dot" />
          <span>{connectionLabel}</span>
        </span>
        <span className="sb-footer__actions">
          <button
            type="button"
            className="sb-footer__collapse"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? t('sidebar.footer.expand') : t('sidebar.footer.collapse')}
            aria-label={collapsed ? t('sidebar.footer.expand') : t('sidebar.footer.collapse')}
            aria-pressed={collapsed}
          >
            {collapsed
              ? <PanelLeftOpen size={13} aria-hidden="true" />
              : <PanelLeftClose size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="sb-footer__help"
            title={t('sidebar.footer.help')}
            aria-label={t('sidebar.footer.help')}
            onClick={onOpenHelp}
          >
            <HelpCircle size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
    </aside>
  )
}
