import {
  Activity,
  Boxes,
  Database,
  FlaskConical,
  GitBranch,
  KeyRound,
  Layers3,
  Settings2,
  ShieldAlert,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../i18n'
import type { ActiveTab } from '../types'
import {
  getWorkspaceDestination,
  listWorkspaceSections,
  workspaceDestinationForTab,
} from '../workspace-locations'

const SECTION_ICONS: Partial<Record<ActiveTab, ReactNode>> = {
  workflows: <Database size={14} />,
  copilot: <Sparkles size={14} />,
  inspector: <GitBranch size={14} />,
  templates: <Workflow size={14} />,
  packs: <Boxes size={14} />,
  experiments: <FlaskConical size={14} />,
  runs: <Activity size={14} />,
  recover: <ShieldAlert size={14} />,
  reasoning: <GitBranch size={14} />,
  multiAgent: <Layers3 size={14} />,
  operations: <Settings2 size={14} />,
  credentials: <KeyRound size={14} />,
  members: <Users size={14} />,
  marketplace: <Boxes size={14} />,
}

export function WorkspaceSectionNav({
  activeTab,
  permissions,
  onOpenTab,
}: {
  activeTab: ActiveTab
  permissions?: readonly string[]
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const destinationId = workspaceDestinationForTab(activeTab)
  if (destinationId === 'home') return null

  const destination = getWorkspaceDestination(destinationId)
  const sections = listWorkspaceSections(destinationId, permissions)
  const destinationLabel = t(destination.labelKey)

  return (
    <nav
      className="workspace-section-nav"
      aria-label={t('workspace.sectionNav.aria', { destination: destinationLabel })}
      data-destination={destinationId}
      data-testid="workspace-section-nav"
    >
      <div className="workspace-section-nav__intro">
        <strong>{destinationLabel}</strong>
        <span>{t(destination.helperKey)}</span>
      </div>
      <div className="workspace-section-nav__rail">
        {sections.map((section) => {
          const label = t(section.labelKey)
          const active = activeTab === section.tab
          return (
            <button
              key={section.tab}
              type="button"
              className="workspace-section-nav__item"
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              onClick={() => onOpenTab(section.tab)}
              title={`${label} — ${t(section.helperKey)}`}
            >
              <span aria-hidden="true">{SECTION_ICONS[section.tab]}</span>
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
