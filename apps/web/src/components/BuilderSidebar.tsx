/**
 * Persistent task-space navigator.
 *
 * Four stable destinations expose the product's user-facing information
 * architecture. Workflow controls and the node palette render only in
 * authoring contexts, keeping Home and operational workspaces focused on
 * their current task.
 *
 * Used by `App.tsx`.
 *
 * Persists open-category state to localStorage under
 * `janusly:sidebar:state` so the operator's collapse choices survive a
 * page reload. Search filters navigation everywhere and step types while
 * authoring.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkflowStore } from '../store'
import {
  Activity,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileInput,
  GitBranch,
  GitFork,
  Globe,
  HelpCircle,
  Home,
  Layers3,
  Mail,
  ListTree,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Loader2,
  Play,
  Plug,
  Plus,
  Radio,
  Repeat,
  Route,
  Save,
  Search,
  Settings2,
  Sparkles,
  Split,
  SquarePlus,
  Timer,
  UserCheck,
  Users,
  Webhook,
  Workflow,
} from 'lucide-react'
import { getNodeHelper, getNodeLabel, nodeTypes } from '../constants'
import type { ActiveTab, AiHealth } from '../types'
import { useT } from '../i18n'
import { MOBILE_WORKSPACE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { writeNodePaletteDrag } from '../canvas-node-drag'
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
  onAdd: (type: string) => void
  onValidate: () => void | Promise<void>
  onSave: () => void | Promise<void>
  onNew: () => void
  onStart: () => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
  onOpenHelp: () => void
}

const STORAGE_KEY = 'janusly:sidebar:state'

type StoredState = {
  openCategories: string[]
  collapsed: boolean
}

const DEFAULT_OPEN_CATEGORIES = ['ai', 'flow']
const PINNED_PALETTE: string[] = ['http', 'ai', 'condition', 'tool']

const NODE_CATEGORIES: Record<string, string[]> = {
  ai: ['ai', 'agent', 'multi_agent', 'agent_reflection'],
  flow: ['condition', 'router', 'router_llm', 'loop', 'parallel_fork', 'join'],
  human: ['approval', 'human_form'],
  tools: ['tool', 'http', 'webhook', 'mcp_tool', 'subworkflow'],
  triggers: ['schedule', 'webhook_received', 'email_received', 'file_dropped', 'mcp_server_event'],
  misc: ['noop', 'transform', 'wait_until'],
}

const NODE_ICONS: Record<string, React.ReactNode> = {
  http: <Globe size={13} />,
  noop: <SquarePlus size={13} />,
  transform: <GitBranch size={13} />,
  condition: <CheckCircle2 size={13} />,
  webhook: <Webhook size={13} />,
  approval: <UserCheck size={13} />,
  human_form: <ClipboardList size={13} />,
  ai: <Sparkles size={13} />,
  tool: <Boxes size={13} />,
  agent: <Users size={13} />,
  router: <Route size={13} />,
  router_llm: <GitFork size={13} />,
  loop: <Repeat size={13} />,
  agent_reflection: <Activity size={13} />,
  multi_agent: <Layers3 size={13} />,
  subworkflow: <Workflow size={13} />,
  wait_until: <Timer size={13} />,
  parallel_fork: <Split size={13} />,
  join: <ListTree size={13} />,
  schedule: <CalendarClock size={13} />,
  mcp_tool: <Plug size={13} />,
  webhook_received: <Webhook size={13} />,
  email_received: <Mail size={13} />,
  file_dropped: <FileInput size={13} />,
  mcp_server_event: <Radio size={13} />,
}

const DESTINATION_ICONS: Record<WorkspaceDestination, React.ReactNode> = {
  home: <Home size={14} />,
  workflows: <Workflow size={14} />,
  activity: <Activity size={14} />,
  settings: <Settings2 size={14} />,
}

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  ai: 'sidebar.category.ai',
  flow: 'sidebar.category.flow',
  human: 'sidebar.category.human',
  tools: 'sidebar.category.tools',
  triggers: 'sidebar.category.triggers',
  misc: 'sidebar.category.misc',
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  ai: <Sparkles size={11} />,
  flow: <GitBranch size={11} />,
  human: <UserCheck size={11} />,
  tools: <Boxes size={11} />,
  misc: <Network size={11} />,
}

/** Closed set of keys accepted from persisted state. */
const VALID_CATEGORY_KEYS = new Set<string>(Object.keys(NODE_CATEGORIES))

function loadStoredState(): StoredState {
  const fallback: StoredState = { openCategories: DEFAULT_OPEN_CATEGORIES, collapsed: false }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<StoredState>
    return {
      openCategories: Array.isArray(parsed.openCategories)
        ? parsed.openCategories.filter((k): k is string => typeof k === 'string' && VALID_CATEGORY_KEYS.has(k))
        : DEFAULT_OPEN_CATEGORIES,
      collapsed: parsed.collapsed === true,
    }
  } catch {
    return fallback
  }
}

function persistState(state: StoredState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // private mode etc.; ignore.
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
  onAdd,
  onValidate,
  onSave,
  onNew,
  onStart,
  onOpenTab,
  onOpenHelp,
  onWorkflowNameChange,
}: BuilderSidebarProps) {
  const { t } = useT()
  const isMobile = useMediaQuery(MOBILE_WORKSPACE_QUERY)
  // Surface unsaved canvas edits in the header so the operator never loses
  // track of save state before navigating away or running.
  const currentWorkflowSaved = useWorkflowStore(state => state.currentWorkflowSaved)
  // In-flight state for the header actions: each shows a spinner + disables the
  // strip while its async handler runs, so a slow Save/Validate/Run gives clear
  // feedback and can't be double-submitted.
  const [busyAction, setBusyAction] = useState<'validate' | 'save' | 'run' | null>(null)
  const busyActionRef = useRef<typeof busyAction>(null)
  const runAction = async (kind: 'validate' | 'save' | 'run', fn: () => void | Promise<void>) => {
    if (busyActionRef.current) return
    busyActionRef.current = kind
    setBusyAction(kind)
    try {
      await fn()
    } finally {
      busyActionRef.current = null
      setBusyAction(null)
    }
  }
  const [stored] = useState<StoredState>(() => loadStoredState())
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => new Set(stored.openCategories))
  const [collapsed, setCollapsed] = useState<boolean>(stored.collapsed)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    persistState({ openCategories: Array.from(openCategories), collapsed })
  }, [openCategories, collapsed])

  // Reflect collapsed state on the workspace shell so the grid column
  // shrinks from 300px to 56px. The data attribute is read by CSS.
  const visuallyCollapsed = collapsed && !isMobile

  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = visuallyCollapsed ? 'true' : 'false'
    return () => { document.documentElement.dataset.sidebarCollapsed = 'false' }
  }, [visuallyCollapsed])

  const toggleCategory = (key: string) => {
    setOpenCategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const normalisedQuery = searchQuery.trim().toLowerCase()
  const authoringMode = activeTab === 'copilot' || activeTab === 'inspector'

  const filteredDestinations = useMemo(() => {
    const allowed = WORKSPACE_DESTINATION_DEFINITIONS.filter((destination) =>
      canOpenWorkspaceDestination(destination.id, permissions))
    if (!normalisedQuery) return allowed
    return allowed.filter((destination) => {
      const label = t(destination.labelKey).toLowerCase()
      const helper = t(destination.helperKey).toLowerCase()
      return label.includes(normalisedQuery) || helper.includes(normalisedQuery)
    })
  }, [normalisedQuery, permissions, t])

  const filteredCategoryNodes = useMemo<Record<string, string[]>>(() => {
    const known = new Set(nodeTypes)
    const filtered: Record<string, string[]> = {}
    for (const [key, types] of Object.entries(NODE_CATEGORIES)) {
      filtered[key] = types.filter(type => {
        if (!known.has(type)) return false
        if (!normalisedQuery) return true
        const label = (getNodeLabel(type) ?? '').toLowerCase()
        const helper = (getNodeHelper(type) ?? '').toLowerCase()
        return label.includes(normalisedQuery) || helper.includes(normalisedQuery) || type.toLowerCase().includes(normalisedQuery)
      })
    }
    return filtered
  }, [normalisedQuery])

  const filteredPinned = useMemo<string[]>(() => {
    const known = new Set(nodeTypes)
    return PINNED_PALETTE.filter(type => {
      if (!known.has(type)) return false
      if (!normalisedQuery) return true
      const label = (getNodeLabel(type) ?? '').toLowerCase()
      return label.includes(normalisedQuery) || type.toLowerCase().includes(normalisedQuery)
    })
  }, [normalisedQuery])

  const aiModeLabel = aiHealth?.enabled ? t('sidebar.aiMode.connected') : t('sidebar.aiMode.localMode')
  const aiSubline = aiHealth?.enabled
    ? t('sidebar.aiMode.tagline', { model: aiHealth.model })
    : t('sidebar.aiMode.copyLocal')
  const envLabel = workflowEnv === 'production' ? t('sidebar.workflow.envProduction') : t('sidebar.workflow.envSandbox')
  const isProduction = workflowEnv === 'production'
  const connectionLabel = streamStatus === 'connected' ? t('sidebar.footer.connected') : streamStatus
  const canWriteWorkflow = permissions.includes('workflows.write')

  return (
    <aside className="builder-sidebar" data-collapsed={visuallyCollapsed ? 'true' : 'false'}>
      {authoringMode && <div className={`sb-workflow ${isProduction ? 'sb-workflow--prod' : 'sb-workflow--sandbox'}`}>
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
          <span>{t(streamStatus === 'connected' ? 'sidebar.workflow.status.idle' : `sidebar.streamStatus.${streamStatus}` as never)}</span>
          {workflowVersion !== null ? (
            <>
              <span className="sb-workflow__sep" aria-hidden="true">·</span>
              <span><b>v{workflowVersion}</b> {t('sidebar.workflow.meta.version')}</span>
            </>
          ) : null}
          {workflowRunsCount !== null ? (
            <>
              <span className="sb-workflow__sep" aria-hidden="true">·</span>
              <span><b>{workflowRunsCount}</b> {t('sidebar.workflow.meta.runs', { count: workflowRunsCount })}</span>
            </>
          ) : null}
          {!currentWorkflowSaved ? (
            <>
              <span className="sb-workflow__sep" aria-hidden="true">·</span>
              <span className="sb-workflow__unsaved" data-testid="sidebar-unsaved">
                {t('sidebar.workflow.meta.unsaved')}
              </span>
            </>
          ) : null}
        </div>
        <div className="sb-workflow__acts">
          <button className="sb-workflow__ghost" type="button" onClick={onNew} disabled={busyAction !== null || !permissions.includes('workflows.write')} title={t('sidebar.action.new')} aria-label={t('sidebar.action.new')}>
            <SquarePlus size={13} aria-hidden="true" />
          </button>
          <button className="sb-workflow__ghost" type="button" onClick={() => runAction('validate', onValidate)} disabled={busyAction !== null || !permissions.includes('workflows.write')} aria-busy={busyAction === 'validate'} title={t('sidebar.action.validate')} aria-label={t('sidebar.action.validate')}>
            {busyAction === 'validate' ? <Loader2 size={13} className="we-spin" aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
          </button>
          <button className="sb-workflow__ghost" type="button" onClick={() => runAction('save', onSave)} disabled={busyAction !== null || !permissions.includes('workflows.write')} aria-busy={busyAction === 'save'} title={t('sidebar.action.save')} aria-label={t('sidebar.action.save')}>
            {busyAction === 'save' ? <Loader2 size={13} className="we-spin" aria-hidden="true" /> : <Save size={13} aria-hidden="true" />}
          </button>
          <button className="sb-workflow__run" type="button" onClick={() => runAction('run', onStart)} disabled={busyAction !== null || !permissions.includes('runs.start')} aria-busy={busyAction === 'run'}>
            {busyAction === 'run' ? <Loader2 size={12} className="we-spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            <span>{busyAction === 'run' ? t('sidebar.action.running') : t('sidebar.action.run')}</span>
          </button>
        </div>
      </div>}

      {authoringMode && permissions.includes('ai.write') && <button
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
      </button>}

      {/* Search */}
      <div className="sb-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t(authoringMode ? 'sidebar.search.placeholder' : 'sidebar.search.navigationPlaceholder')}
          aria-label={t(authoringMode ? 'sidebar.search.placeholder' : 'sidebar.search.navigationPlaceholder')}
          data-shortcut="sidebar-search"
        />
        <kbd>/</kbd>
      </div>

      {/* Global destinations */}
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
                    <span className="sb-view__ic" aria-hidden="true">
                      {DESTINATION_ICONS[destination.id]}
                    </span>
                    <span className="sb-view__label">{label}</span>
                    <span className="sb-view__meta">{destination.shortcut}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>

      {authoringMode && filteredPinned.length > 0 && (
        <div className="sb-group sb-group--open sb-pinned">
          <div className="sb-group__head sb-group__head--static">
            <span className="sb-group__head-label">
              <Plus size={11} className="sb-group__chev" aria-hidden="true" />
              <span>{t('sidebar.palette.pinned')}</span>
            </span>
            <span className="sb-group__count">{filteredPinned.length}</span>
          </div>
          <div className="sb-palette">
            {filteredPinned.map(type => {
              const label = getNodeLabel(type)
              const helper = getNodeHelper(type)
              return (
                <button
                  key={`pinned-${type}`}
                  className="sb-chip sb-chip--pinned"
                  type="button"
                  draggable={canWriteWorkflow}
                  disabled={!canWriteWorkflow}
                  onDragStart={(event) => {
                    if (canWriteWorkflow) writeNodePaletteDrag(event.dataTransfer, type)
                  }}
                  onClick={() => onAdd(type)}
                  title={`${label} — ${helper}`}
                >
                  <span className="sb-chip__ic" aria-hidden="true">{NODE_ICONS[type] ?? <SquarePlus size={11} />}</span>
                  <span className="sb-chip__label">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {authoringMode && <div className="sb-categories">
        {Object.entries(filteredCategoryNodes).map(([key, types]) => {
          if (types.length === 0) return null
          const isOpen = openCategories.has(key)
          return (
            <div key={key} className={`sb-cat ${isOpen ? 'sb-cat--open' : ''}`}>
              <button className="sb-cat__head" type="button" onClick={() => toggleCategory(key)} aria-expanded={isOpen}>
                <span className="sb-cat__head-label">
                  <span className="sb-cat__head-ic" aria-hidden="true">{CATEGORY_ICONS[key]}</span>
                  <span>{t(CATEGORY_LABEL_KEYS[key] as never)}</span>
                </span>
                <span className="sb-cat__head-meta">
                  <span>{types.length}</span>
                  <ChevronRight size={11} className="sb-cat__chev" aria-hidden="true" />
                </span>
              </button>
              {isOpen && (
                <div className="sb-palette">
                  {types.map(type => {
                    const label = getNodeLabel(type)
                    const helper = getNodeHelper(type)
                    return (
                      <button
                        key={type}
                        className="sb-chip"
                        type="button"
                        draggable={canWriteWorkflow}
                        disabled={!canWriteWorkflow}
                        onDragStart={(event) => {
                          if (canWriteWorkflow) writeNodePaletteDrag(event.dataTransfer, type)
                        }}
                        onClick={() => onAdd(type)}
                        title={`${label} — ${helper}`}
                      >
                        <span className="sb-chip__ic" aria-hidden="true">{NODE_ICONS[type] ?? <SquarePlus size={11} />}</span>
                        <span className="sb-chip__label">{label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>}

      {/* Bottom utility strip */}
      <div className="sb-footer">
        <span className={`sb-footer__live sb-footer__live--${streamStatus}`}>
          <span className="sb-footer__dot" />
          <span>{connectionLabel}</span>
        </span>
        <span className="sb-footer__actions">
          <button
            type="button"
            className="sb-footer__collapse"
            onClick={() => setCollapsed(prev => !prev)}
            title={collapsed ? t('sidebar.footer.expand') : t('sidebar.footer.collapse')}
            aria-label={collapsed ? t('sidebar.footer.expand') : t('sidebar.footer.collapse')}
            aria-pressed={collapsed}
          >
            {collapsed ? <PanelLeftOpen size={13} aria-hidden="true" /> : <PanelLeftClose size={13} aria-hidden="true" />}
          </button>
          <button type="button" className="sb-footer__help" title={t('sidebar.footer.help')} aria-label={t('sidebar.footer.help')} onClick={onOpenHelp}>
            <HelpCircle size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
    </aside>
  )
}
