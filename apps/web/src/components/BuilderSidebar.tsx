/**
 * Left-rail sidebar — workflow name input, primary actions (Validate /
 * Save / Run), tab navigation that opens panels in `RightPanel`, and the
 * "Add step" shortcut grid.
 *
 * Used by `App.tsx`.
 */

import React from 'react'
import { Activity, Boxes, Bot, CheckCircle2, ChevronRight, ClipboardList, Database, Gauge, GitBranch, Home, KeyRound, Layers3, Play, Save, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { nodeTypes, nodeUi } from '../constants'
import type { ActiveTab, AiHealth } from '../types'

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

const navItems: Array<{ tab: ActiveTab; label: string; helper: string; icon: React.ReactNode }> = [
  { tab: 'home', label: 'Home', helper: 'Recovery Center', icon: <Home size={15} /> },
  { tab: 'copilot', label: 'AI Studio', helper: 'Draft and explain', icon: <Sparkles size={15} /> },
  { tab: 'workflows', label: 'Flows', helper: 'Saved versions', icon: <Database size={15} /> },
  { tab: 'multiAgent', label: 'Multi-agent timeline', helper: 'Agent events', icon: <Layers3 size={15} /> },
  { tab: 'inspector', label: 'Step setup', helper: 'Edit selected step', icon: <GitBranch size={15} /> },
  { tab: 'runs', label: 'Runs', helper: 'Execution history', icon: <Activity size={15} /> },
  { tab: 'operations', label: 'Operations', helper: 'Org-wide recovery posture', icon: <Gauge size={15} /> },
  { tab: 'members', label: 'Team', helper: 'Access control', icon: <Users size={15} /> },
  { tab: 'templates', label: 'Recipes', helper: 'Starting patterns', icon: <Workflow size={15} /> },
  { tab: 'marketplace', label: 'Tools', helper: 'Backend actions', icon: <Boxes size={15} /> },
  { tab: 'credentials', label: 'Connections', helper: 'Secrets by reference', icon: <KeyRound size={15} /> },
]

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
  const aiModeLabel = aiHealth?.enabled ? 'AI connected' : 'Local mode'
  const aiModeCopy = aiHealth?.enabled
    ? `${aiHealth.model} is ready for flow drafting and explanations.`
    : 'Janusly can still draft, explain, and run with local rules.'

  return (
    <aside className="builder-sidebar">
      <div className="sidebar-section">
        <div className="section-kicker">Flow</div>
        <label className="field-label" htmlFor="workflow-name">Name</label>
        <input
          id="workflow-name"
          value={workflowName}
          onChange={(event) => onWorkflowNameChange(event.target.value)}
          className="text-field"
        />
        <div className="status-row">
          <span className={`status-dot status-dot-${streamStatus}`} />
          <span>{streamStatus}</span>
        </div>
      </div>

      <div className="sidebar-section ai-mode-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">AI mode</div>
            <strong>{aiModeLabel}</strong>
          </div>
          <span className={aiHealth?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {aiHealth?.enabled ? 'Live' : 'Local'}
          </span>
        </div>
        <p>{aiModeCopy}</p>
        <button onClick={() => onOpenTab('copilot')} className="command-button command-button-primary">
          <Bot size={16} aria-hidden="true" />
          <span>Describe flow</span>
        </button>
      </div>

      <div className="sidebar-section sidebar-actions">
        <button onClick={onNew} className="command-button command-button-quiet">
          <SquarePlus size={16} aria-hidden="true" />
          <span>New</span>
        </button>
        <button onClick={onValidate} className="command-button command-button-quiet">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>Validate</span>
        </button>
        <button onClick={onSave} className="command-button command-button-quiet">
          <Save size={16} aria-hidden="true" />
          <span>Save</span>
        </button>
        <button onClick={onStart} className="command-button command-button-primary">
          <Play size={16} aria-hidden="true" />
          <span>Run</span>
        </button>
      </div>

      <nav className="sidebar-section" aria-label="Workspace views">
        <div className="section-kicker">Views</div>
        <div className="view-list">
          {navItems.map(item => (
            <button
              key={item.tab}
              onClick={() => onOpenTab(item.tab)}
              aria-label={item.label}
              aria-current={activeTab === item.tab ? 'page' : undefined}
              className={activeTab === item.tab ? 'view-button view-button-active' : 'view-button'}
            >
              <span className="view-icon">{item.icon}</span>
              <span className="view-copy">
                <strong>{item.label}</strong>
                <small>{item.helper}</small>
              </span>
              <ChevronRight className="view-arrow" size={14} aria-hidden="true" />
            </button>
          ))}
        </div>
      </nav>

      <div className="sidebar-section">
        <div className="section-kicker">Add step</div>
        <div className="node-palette">
          {nodeTypes.map(type => {
            const copy = nodeUi[type] ?? { label: type.replace('_', ' '), helper: 'Workflow step' }
            return (
              <button key={type} onClick={() => onAdd(type)} className="node-chip" title={`${copy.label}: ${copy.helper}`}>
                <span className="node-chip-main">
                  {nodeIcons[type] ?? <SquarePlus size={15} aria-hidden="true" />}
                  <span>{copy.label}</span>
                </span>
                <small>{copy.helper}</small>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
