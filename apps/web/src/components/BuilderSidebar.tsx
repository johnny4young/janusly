/**
 * Left-rail sidebar — workflow name input, primary actions (Validate /
 * Save / Run), tab navigation that opens panels in `RightPanel`, and the
 * "Add step" shortcut grid.
 *
 * Used by `App.tsx`.
 */

import React from 'react'
import { Activity, Boxes, Bot, CheckCircle2, ChevronRight, ClipboardList, Database, Gauge, GitBranch, Home, KeyRound, Layers3, Play, Save, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { getNodeHelper, getNodeLabel, nodeTypes } from '../constants'
import type { ActiveTab, AiHealth } from '../types'
import { useT } from '../i18n'

type BuilderSidebarProps = {
  workflowName: string
  activeTab: ActiveTab
  streamStatus: string
  aiHealth: AiHealth | null
  onWorkflowNameChange: (name: string) => void
  onAdd: (type: string) => void
  onValidate: () => void
  onSave: () => void
  onNew: () => void
  onStart: () => void
  onOpenTab: (tab: ActiveTab) => void
}

const nodeIcons: Record<string, React.ReactNode> = {
  http: <Activity size={15} />,
  noop: <SquarePlus size={15} />,
  transform: <GitBranch size={15} />,
  loop: <Workflow size={15} />,
  condition: <CheckCircle2 size={15} />,
  webhook: <Activity size={15} />,
  approval: <Users size={15} />,
  human_form: <ClipboardList size={15} />,
  ai: <Sparkles size={15} />,
  tool: <Boxes size={15} />,
  agent: <Users size={15} />,
  agent_reflection: <Activity size={15} />,
  multi_agent: <Layers3 size={15} />,
}

type NavItem = { tab: ActiveTab; labelKey: string; helperKey: string; icon: React.ReactNode }

const navItems: NavItem[] = [
  { tab: 'home', labelKey: 'sidebar.nav.home.label', helperKey: 'sidebar.nav.home.helper', icon: <Home size={15} /> },
  { tab: 'copilot', labelKey: 'sidebar.nav.copilot.label', helperKey: 'sidebar.nav.copilot.helper', icon: <Sparkles size={15} /> },
  { tab: 'workflows', labelKey: 'sidebar.nav.workflows.label', helperKey: 'sidebar.nav.workflows.helper', icon: <Database size={15} /> },
  { tab: 'multiAgent', labelKey: 'sidebar.nav.multiAgent.label', helperKey: 'sidebar.nav.multiAgent.helper', icon: <Layers3 size={15} /> },
  { tab: 'inspector', labelKey: 'sidebar.nav.inspector.label', helperKey: 'sidebar.nav.inspector.helper', icon: <GitBranch size={15} /> },
  { tab: 'runs', labelKey: 'sidebar.nav.runs.label', helperKey: 'sidebar.nav.runs.helper', icon: <Activity size={15} /> },
  { tab: 'operations', labelKey: 'sidebar.nav.operations.label', helperKey: 'sidebar.nav.operations.helper', icon: <Gauge size={15} /> },
  { tab: 'members', labelKey: 'sidebar.nav.members.label', helperKey: 'sidebar.nav.members.helper', icon: <Users size={15} /> },
  { tab: 'templates', labelKey: 'sidebar.nav.templates.label', helperKey: 'sidebar.nav.templates.helper', icon: <Workflow size={15} /> },
  { tab: 'marketplace', labelKey: 'sidebar.nav.marketplace.label', helperKey: 'sidebar.nav.marketplace.helper', icon: <Boxes size={15} /> },
  { tab: 'credentials', labelKey: 'sidebar.nav.credentials.label', helperKey: 'sidebar.nav.credentials.helper', icon: <KeyRound size={15} /> },
]

const STREAM_STATUS_KEYS: Record<string, string> = {
  connecting: 'sidebar.streamStatus.connecting',
  connected: 'sidebar.streamStatus.connected',
  error: 'sidebar.streamStatus.error',
  closed: 'sidebar.streamStatus.closed',
}

/** Render the left-rail sidebar with name + actions + tab nav + node palette. */
export function BuilderSidebar({
  activeTab,
  aiHealth,
  workflowName,
  streamStatus,
  onAdd,
  onValidate,
  onSave,
  onNew,
  onStart,
  onOpenTab,
  onWorkflowNameChange,
}: BuilderSidebarProps) {
  const { t } = useT()
  const aiModeLabel = aiHealth?.enabled ? t('sidebar.aiMode.connected') : t('sidebar.aiMode.localMode')
  const aiModeCopy = aiHealth?.enabled
    ? t('sidebar.aiMode.copyConnected', { model: aiHealth.model })
    : t('sidebar.aiMode.copyLocal')
  const streamStatusLabel = (STREAM_STATUS_KEYS[streamStatus] ? t(STREAM_STATUS_KEYS[streamStatus] as never) : streamStatus) as string

  return (
    <aside className="builder-sidebar">
      <div className="sidebar-section">
        <div className="section-kicker">{t('sidebar.section.flow')}</div>
        <label className="field-label" htmlFor="workflow-name">{t('sidebar.field.name')}</label>
        <input
          id="workflow-name"
          value={workflowName}
          onChange={(event) => onWorkflowNameChange(event.target.value)}
          className="text-field"
        />
        <div className="status-row">
          <span className={`status-dot status-dot-${streamStatus}`} />
          <span>{streamStatusLabel}</span>
        </div>
      </div>

      <div className="sidebar-section ai-mode-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('sidebar.section.aiMode')}</div>
            <strong>{aiModeLabel}</strong>
          </div>
          <span className={aiHealth?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {aiHealth?.enabled ? t('sidebar.aiMode.live') : t('sidebar.aiMode.local')}
          </span>
        </div>
        <p>{aiModeCopy}</p>
        <button onClick={() => onOpenTab('copilot')} className="command-button command-button-primary">
          <Bot size={16} aria-hidden="true" />
          <span>{t('sidebar.aiMode.describe')}</span>
        </button>
      </div>

      <div className="sidebar-section sidebar-actions">
        <button onClick={onNew} className="command-button command-button-quiet">
          <SquarePlus size={16} aria-hidden="true" />
          <span>{t('sidebar.action.new')}</span>
        </button>
        <button onClick={onValidate} className="command-button command-button-quiet">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{t('sidebar.action.validate')}</span>
        </button>
        <button onClick={onSave} className="command-button command-button-quiet">
          <Save size={16} aria-hidden="true" />
          <span>{t('sidebar.action.save')}</span>
        </button>
        <button onClick={onStart} className="command-button command-button-primary">
          <Play size={16} aria-hidden="true" />
          <span>{t('sidebar.action.run')}</span>
        </button>
      </div>

      <nav className="sidebar-section" aria-label={t('sidebar.workspaceViews')}>
        <div className="section-kicker">{t('sidebar.section.views')}</div>
        <div className="view-list">
          {navItems.map(item => {
            const label = t(item.labelKey as never) as string
            const helper = t(item.helperKey as never) as string
            return (
              <button
                key={item.tab}
                onClick={() => onOpenTab(item.tab)}
                aria-label={label}
                aria-current={activeTab === item.tab ? 'page' : undefined}
                className={activeTab === item.tab ? 'view-button view-button-active' : 'view-button'}
              >
                <span className="view-icon">{item.icon}</span>
                <span className="view-copy">
                  <strong>{label}</strong>
                  <small>{helper}</small>
                </span>
                <ChevronRight className="view-arrow" size={14} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </nav>

      <div className="sidebar-section">
        <div className="section-kicker">{t('sidebar.section.addStep')}</div>
        <div className="node-palette">
          {nodeTypes.map(type => {
            const label = getNodeLabel(type)
            const helper = getNodeHelper(type)
            return (
              <button key={type} onClick={() => onAdd(type)} className="node-chip" title={t('sidebar.nodeChip.title', { label, helper })}>
                <span className="node-chip-main">
                  {nodeIcons[type] ?? <SquarePlus size={15} aria-hidden="true" />}
                  <span>{label}</span>
                </span>
                <small>{helper}</small>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
