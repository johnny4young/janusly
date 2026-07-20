/**
 * Left-rail sidebar — Janusly Studio's persistent workspace navigator.
 *
 * Replicates `ui_kits/studio/sidebar.html` from the design system zip:
 * (1) workflow header card (name + env chip + status row + 4-col action
 * strip), (2) AI-mode one-line strip, (3) search input, (4) grouped views
 * with collapse/expand state (Pinned / Build / Run),
 * (5) pinned step palette + categorized step palette (AI / Flow control /
 * Human-in-the-loop / Tools & integrations / Misc), (6) bottom utility
 * strip with connection live indicator.
 *
 * Used by `App.tsx`.
 *
 * Persists open-group / open-category state to localStorage under
 * `janusly:sidebar:state` so the operator's collapse choices survive a
 * page reload. Search filters BOTH views and step types in one keystroke.
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
  Database,
  FileInput,
  FlaskConical,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  HelpCircle,
  Home,
  KeyRound,
  Layers3,
  Mail,
  ListTree,
  Network,
  Package,
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

type BuilderSidebarProps = {
  workflowName: string
  activeTab: ActiveTab
  streamStatus: string
  aiHealth: AiHealth | null
  workflowEnv?: 'sandbox' | 'production'
  workflowVersion?: number | null
  workflowRunsCount?: number | null
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
  openGroups: string[]
  openCategories: string[]
  collapsed: boolean
}

const DEFAULT_OPEN_GROUPS = ['pinned', 'build', 'run']
const DEFAULT_OPEN_CATEGORIES = ['ai', 'flow']
const PINNED_PALETTE: string[] = ['http', 'ai', 'condition', 'tool']

const NODE_CATEGORIES: Record<string, string[]> = {
  ai: ['ai', 'agent', 'multi_agent', 'agent_reflection'],
  flow: ['condition', 'router', 'router_llm', 'loop', 'parallel_fork', 'join'],
  human: ['approval', 'human_form'],
  tools: ['tool', 'http', 'webhook', 'mcp_tool', 'subworkflow'],
  triggers: ['schedule', 'email_received', 'file_dropped', 'mcp_server_event'],
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
  email_received: <Mail size={13} />,
  file_dropped: <FileInput size={13} />,
  mcp_server_event: <Radio size={13} />,
}

type NavItem = {
  tab: ActiveTab
  labelKey: string
  helperKey: string
  icon: React.ReactNode
  meta?: string
}

type NavGroup = {
  key: 'pinned' | 'build' | 'run'
  labelKey: string
  items: NavItem[]
}

/** Three nav groups: Pinned (home shortcut), Build (authoring + discovery —
 *  Templates/Marketplace live here because they're the surfaces an operator
 *  uses to FIND the building blocks of a workflow), Run (operate-the-org —
 *  Credentials/Members live here because they're runtime config, not authoring).
 *
 *  Adding a new tab means deciding which group it conceptually belongs to:
 *  - "authoring or discovery" → Build
 *  - "production-runtime config or admin" → Run
 *  - "always-accessible shortcut" → Pinned
 *
 *  Adding a fourth group is a bigger UX call — three groups is the comfortable
 *  ceiling for a vertical sidebar (PagerDuty / Vercel / Linear all converge
 *  here). Re-evaluate only when an 11-item group emerges with no clean
 *  sub-categorization. */
const NAV_GROUPS: NavGroup[] = [
  {
    key: 'pinned',
    labelKey: 'sidebar.group.pinned',
    items: [
      { tab: 'home', labelKey: 'sidebar.nav.home.label', helperKey: 'sidebar.nav.home.helper', icon: <Home size={13} />, meta: '⌘1' },
    ],
  },
  {
    key: 'build',
    labelKey: 'sidebar.group.build',
    items: [
      { tab: 'copilot', labelKey: 'sidebar.nav.copilot.label', helperKey: 'sidebar.nav.copilot.helper', icon: <Sparkles size={13} />, meta: '⌘2' },
      { tab: 'experiments', labelKey: 'sidebar.nav.experiments.label', helperKey: 'sidebar.nav.experiments.helper', icon: <FlaskConical size={13} /> },
      { tab: 'workflows', labelKey: 'sidebar.nav.workflows.label', helperKey: 'sidebar.nav.workflows.helper', icon: <Database size={13} /> },
      { tab: 'inspector', labelKey: 'sidebar.nav.inspector.label', helperKey: 'sidebar.nav.inspector.helper', icon: <GitBranch size={13} /> },
      { tab: 'templates', labelKey: 'sidebar.nav.templates.label', helperKey: 'sidebar.nav.templates.helper', icon: <Workflow size={13} /> },
      { tab: 'packs', labelKey: 'sidebar.nav.packs.label', helperKey: 'sidebar.nav.packs.helper', icon: <Package size={13} /> },
      { tab: 'marketplace', labelKey: 'sidebar.nav.marketplace.label', helperKey: 'sidebar.nav.marketplace.helper', icon: <Boxes size={13} /> },
    ],
  },
  {
    key: 'run',
    labelKey: 'sidebar.group.run',
    items: [
      { tab: 'runs', labelKey: 'sidebar.nav.runs.label', helperKey: 'sidebar.nav.runs.helper', icon: <Activity size={13} /> },
      { tab: 'multiAgent', labelKey: 'sidebar.nav.multiAgent.label', helperKey: 'sidebar.nav.multiAgent.helper', icon: <Layers3 size={13} /> },
      { tab: 'operations', labelKey: 'sidebar.nav.operations.label', helperKey: 'sidebar.nav.operations.helper', icon: <Gauge size={13} /> },
      { tab: 'credentials', labelKey: 'sidebar.nav.credentials.label', helperKey: 'sidebar.nav.credentials.helper', icon: <KeyRound size={13} /> },
      { tab: 'members', labelKey: 'sidebar.nav.members.label', helperKey: 'sidebar.nav.members.helper', icon: <Users size={13} /> },
    ],
  },
]

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

/** Closed sets of keys we accept from persisted state. Any value outside
 *  the set (stale group from a previous version, hand-edited gibberish) is
 *  silently dropped on read so the UI never tries to render or toggle a key
 *  that doesn't exist in the current `NAV_GROUPS` / `NODE_CATEGORIES`. */
const VALID_GROUP_KEYS = new Set<string>(NAV_GROUPS.map((g) => g.key))
const VALID_CATEGORY_KEYS = new Set<string>(Object.keys(NODE_CATEGORIES))

function loadStoredState(): StoredState {
  const fallback: StoredState = { openGroups: DEFAULT_OPEN_GROUPS, openCategories: DEFAULT_OPEN_CATEGORIES, collapsed: false }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<StoredState>
    return {
      openGroups: Array.isArray(parsed.openGroups)
        ? parsed.openGroups.filter((k): k is string => typeof k === 'string' && VALID_GROUP_KEYS.has(k))
        : DEFAULT_OPEN_GROUPS,
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
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(stored.openGroups))
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => new Set(stored.openCategories))
  const [collapsed, setCollapsed] = useState<boolean>(stored.collapsed)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    persistState({ openGroups: Array.from(openGroups), openCategories: Array.from(openCategories), collapsed })
  }, [openGroups, openCategories, collapsed])

  // Reflect collapsed state on the workspace shell so the grid column
  // shrinks from 300px to 56px. The data attribute is read by CSS.
  const visuallyCollapsed = collapsed && !isMobile

  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = visuallyCollapsed ? 'true' : 'false'
    return () => { document.documentElement.dataset.sidebarCollapsed = 'false' }
  }, [visuallyCollapsed])

  const toggleGroup = (key: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const toggleCategory = (key: string) => {
    setOpenCategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const normalisedQuery = searchQuery.trim().toLowerCase()

  const filteredGroups = useMemo<NavGroup[]>(() => {
    if (!normalisedQuery) return NAV_GROUPS
    return NAV_GROUPS.map(group => ({
      ...group,
      items: group.items.filter(item => {
        const label = (t(item.labelKey as never)).toLowerCase()
        const helper = (t(item.helperKey as never)).toLowerCase()
        return label.includes(normalisedQuery) || helper.includes(normalisedQuery)
      }),
    })).filter(group => group.items.length > 0)
  }, [normalisedQuery, t])

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

  return (
    <aside className="builder-sidebar" data-collapsed={visuallyCollapsed ? 'true' : 'false'}>
      {/* Workflow header card */}
      <div className={`sb-workflow ${isProduction ? 'sb-workflow--prod' : 'sb-workflow--sandbox'}`}>
        <div className="sb-workflow__top">
          <label className="sb-workflow__name" aria-label={t('sidebar.workflow.rename')}>
            <span className="sb-workflow__name-ic" aria-hidden="true"><Workflow size={13} /></span>
            <input
              type="text"
              value={workflowName}
              onChange={(event) => onWorkflowNameChange(event.target.value)}
              className="sb-workflow__name-input"
              aria-label={t('sidebar.field.name')}
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
          <button className="sb-workflow__ghost" type="button" onClick={onNew} disabled={busyAction !== null} title={t('sidebar.action.new')} aria-label={t('sidebar.action.new')}>
            <SquarePlus size={13} aria-hidden="true" />
          </button>
          <button className="sb-workflow__ghost" type="button" onClick={() => runAction('validate', onValidate)} disabled={busyAction !== null} aria-busy={busyAction === 'validate'} title={t('sidebar.action.validate')} aria-label={t('sidebar.action.validate')}>
            {busyAction === 'validate' ? <Loader2 size={13} className="we-spin" aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
          </button>
          <button className="sb-workflow__ghost" type="button" onClick={() => runAction('save', onSave)} disabled={busyAction !== null} aria-busy={busyAction === 'save'} title={t('sidebar.action.save')} aria-label={t('sidebar.action.save')}>
            {busyAction === 'save' ? <Loader2 size={13} className="we-spin" aria-hidden="true" /> : <Save size={13} aria-hidden="true" />}
          </button>
          <button className="sb-workflow__run" type="button" onClick={() => runAction('run', onStart)} disabled={busyAction !== null} aria-busy={busyAction === 'run'}>
            {busyAction === 'run' ? <Loader2 size={12} className="we-spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            <span>{busyAction === 'run' ? t('sidebar.action.running') : t('sidebar.action.run')}</span>
          </button>
        </div>
      </div>

      {/* AI mode one-line strip */}
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

      {/* Search */}
      <div className="sb-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('sidebar.search.placeholder')}
          aria-label={t('sidebar.search.placeholder')}
          data-shortcut="sidebar-search"
        />
        <kbd>/</kbd>
      </div>

      {/* Grouped views */}
      <nav className="sb-groups" aria-label={t('sidebar.workspaceViews')}>
        {filteredGroups.map(group => {
          const isOpen = openGroups.has(group.key)
          return (
            <div key={group.key} className={`sb-group ${isOpen ? 'sb-group--open' : ''}`}>
              <button className="sb-group__head" type="button" onClick={() => toggleGroup(group.key)} aria-expanded={isOpen}>
                <span className="sb-group__head-label">
                  <ChevronRight size={11} className="sb-group__chev" aria-hidden="true" />
                  <span>{t(group.labelKey as never)}</span>
                </span>
                <span className="sb-group__count">{group.items.length}</span>
              </button>
              {isOpen && (
                <ul className="sb-group__list">
                  {group.items.map(item => {
                    const label = t(item.labelKey as never)
                    const helper = t(item.helperKey as never)
                    const active = activeTab === item.tab
                    return (
                      <li key={item.tab}>
                        <button
                          className={`sb-view ${active ? 'sb-view--on' : ''}`}
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          onClick={() => onOpenTab(item.tab)}
                          data-mobile-nav-close="true"
                          title={`${label} — ${helper}`}
                        >
                          <span className="sb-view__ic" aria-hidden="true">{item.icon}</span>
                          <span className="sb-view__label">{label}</span>
                          {item.meta ? <span className="sb-view__meta">{item.meta}</span> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </nav>

      {/* Pinned step palette */}
      {filteredPinned.length > 0 && (
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
                  draggable
                  onDragStart={(event) => writeNodePaletteDrag(event.dataTransfer, type)}
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

      {/* Categorized step palette */}
      <div className="sb-categories">
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
                        draggable
                        onDragStart={(event) => writeNodePaletteDrag(event.dataTransfer, type)}
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
      </div>

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
