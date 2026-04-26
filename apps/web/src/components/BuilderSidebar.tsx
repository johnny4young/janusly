import React from 'react'
import { Activity, Boxes, CheckCircle2, Database, GitBranch, KeyRound, Layers3, Play, Save, Sparkles, SquarePlus, Users, Workflow } from 'lucide-react'
import { nodeTypes } from '../constants'
import type { ActiveTab } from '../types'

type BuilderSidebarProps = {
  workflowName: string
  activeTab: ActiveTab
  streamStatus: string
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
  ai: <Sparkles size={15} />,
  tool: <Boxes size={15} />,
  agent: <Users size={15} />,
  agent_reflection: <Activity size={15} />,
  multi_agent: <Layers3 size={15} />,
}

const navItems: Array<{ tab: ActiveTab; label: string; icon: React.ReactNode }> = [
  { tab: 'workflows', label: 'Workflows', icon: <Database size={15} /> },
  { tab: 'crew', label: 'Crew', icon: <Layers3 size={15} /> },
  { tab: 'inspector', label: 'Inspector', icon: <GitBranch size={15} /> },
  { tab: 'runs', label: 'Runs', icon: <Activity size={15} /> },
  { tab: 'members', label: 'Members', icon: <Users size={15} /> },
  { tab: 'templates', label: 'Templates', icon: <Workflow size={15} /> },
  { tab: 'marketplace', label: 'Tools', icon: <Boxes size={15} /> },
  { tab: 'credentials', label: 'Secrets', icon: <KeyRound size={15} /> },
]

export function BuilderSidebar({
  activeTab,
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
  return (
    <aside className="builder-sidebar">
      <div className="sidebar-section">
        <div className="section-kicker">Workflow</div>
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

      <div className="sidebar-section">
        <div className="section-kicker">Add Node</div>
        <div className="node-palette">
          {nodeTypes.map(type => (
            <button key={type} onClick={() => onAdd(type)} className="node-chip" title={`Add ${type} node`}>
              {nodeIcons[type] ?? <SquarePlus size={15} aria-hidden="true" />}
              <span>{type.replace('_', ' ')}</span>
            </button>
          ))}
        </div>
      </div>

      <nav className="sidebar-section" aria-label="Workspace views">
        <div className="section-kicker">Views</div>
        <div className="view-list">
          {navItems.map(item => (
            <button
              key={item.tab}
              onClick={() => onOpenTab(item.tab)}
              className={activeTab === item.tab ? 'view-button view-button-active' : 'view-button'}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  )
}
