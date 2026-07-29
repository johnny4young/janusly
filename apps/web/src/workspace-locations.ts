import { canOpenTab } from './tab-permissions'
import type { ActiveTab } from './types'

export const WORKSPACE_DESTINATIONS = ['home', 'workflows', 'activity', 'settings'] as const

export type WorkspaceDestination = (typeof WORKSPACE_DESTINATIONS)[number]

export type WorkspaceSection = {
  tab: ActiveTab
  labelKey: string
  helperKey: string
  /** Legacy/deep route that stays restorable but does not compete with the
   *  task-level section navigation. */
  hidden?: boolean
  /** Internal modes that should keep this visible section highlighted. */
  activeAliases?: readonly ActiveTab[]
}

export type WorkspaceDestinationDefinition = {
  id: WorkspaceDestination
  labelKey: string
  helperKey: string
  shortcut: string
  sections: readonly WorkspaceSection[]
}

export const WORKSPACE_DESTINATION_DEFINITIONS: readonly WorkspaceDestinationDefinition[] = [
  {
    id: 'home',
    labelKey: 'workspace.destination.home.label',
    helperKey: 'workspace.destination.home.helper',
    shortcut: '⌘1',
    sections: [
      {
        tab: 'home',
        labelKey: 'workspace.section.home.label',
        helperKey: 'workspace.section.home.helper',
      },
    ],
  },
  {
    id: 'workflows',
    labelKey: 'workspace.destination.workflows.label',
    helperKey: 'workspace.destination.workflows.helper',
    shortcut: '⌘2',
    sections: [
      {
        tab: 'workflows',
        labelKey: 'workspace.section.workflows.label',
        helperKey: 'workspace.section.workflows.helper',
      },
      {
        tab: 'inspector',
        labelKey: 'workspace.section.inspector.label',
        helperKey: 'workspace.section.inspector.helper',
        activeAliases: ['copilot'],
      },
      {
        tab: 'copilot',
        labelKey: 'workspace.section.copilot.label',
        helperKey: 'workspace.section.copilot.helper',
        hidden: true,
      },
      {
        tab: 'templates',
        labelKey: 'workspace.section.templates.label',
        helperKey: 'workspace.section.templates.helper',
      },
      {
        tab: 'packs',
        labelKey: 'workspace.section.packs.label',
        helperKey: 'workspace.section.packs.helper',
        hidden: true,
      },
      {
        tab: 'experiments',
        labelKey: 'workspace.section.experiments.label',
        helperKey: 'workspace.section.experiments.helper',
      },
    ],
  },
  {
    id: 'activity',
    labelKey: 'workspace.destination.activity.label',
    helperKey: 'workspace.destination.activity.helper',
    shortcut: '⌘3',
    sections: [
      {
        tab: 'runs',
        labelKey: 'workspace.section.runs.label',
        helperKey: 'workspace.section.runs.helper',
      },
      {
        tab: 'recover',
        labelKey: 'workspace.section.recover.label',
        helperKey: 'workspace.section.recover.helper',
      },
      {
        tab: 'reasoning',
        labelKey: 'workspace.section.reasoning.label',
        helperKey: 'workspace.section.reasoning.helper',
      },
      {
        tab: 'multiAgent',
        labelKey: 'workspace.section.multiAgent.label',
        helperKey: 'workspace.section.multiAgent.helper',
      },
    ],
  },
  {
    id: 'settings',
    labelKey: 'workspace.destination.settings.label',
    helperKey: 'workspace.destination.settings.helper',
    shortcut: '⌘4',
    sections: [
      {
        tab: 'operations',
        labelKey: 'workspace.section.operations.label',
        helperKey: 'workspace.section.operations.helper',
      },
      {
        tab: 'credentials',
        labelKey: 'workspace.section.credentials.label',
        helperKey: 'workspace.section.credentials.helper',
      },
      {
        tab: 'members',
        labelKey: 'workspace.section.members.label',
        helperKey: 'workspace.section.members.helper',
      },
      {
        tab: 'marketplace',
        labelKey: 'workspace.section.marketplace.label',
        helperKey: 'workspace.section.marketplace.helper',
      },
    ],
  },
]

export const PERSISTED_WORKSPACE_TABS: readonly ActiveTab[] =
  WORKSPACE_DESTINATION_DEFINITIONS.flatMap((destination) =>
    destination.sections.map((section) => section.tab))

const DESTINATION_BY_ID = new Map(
  WORKSPACE_DESTINATION_DEFINITIONS.map((destination) => [destination.id, destination]),
)

const DESTINATION_BY_TAB: Record<ActiveTab, WorkspaceDestination> = {
  home: 'home',
  workflows: 'workflows',
  copilot: 'workflows',
  inspector: 'workflows',
  templates: 'workflows',
  packs: 'workflows',
  experiments: 'workflows',
  runs: 'activity',
  recover: 'activity',
  reasoning: 'activity',
  multiAgent: 'activity',
  recoveryCase: 'activity',
  operations: 'settings',
  credentials: 'settings',
  members: 'settings',
  marketplace: 'settings',
}

export function getWorkspaceDestination(
  destination: WorkspaceDestination,
): WorkspaceDestinationDefinition {
  const definition = DESTINATION_BY_ID.get(destination)
  if (!definition) throw new Error(`Unknown workspace destination: ${destination}`)
  return definition
}

export function workspaceDestinationForTab(tab: ActiveTab): WorkspaceDestination {
  return DESTINATION_BY_TAB[tab]
}

export function listWorkspaceSections(
  destination: WorkspaceDestination,
  permissions?: readonly string[],
): readonly WorkspaceSection[] {
  const sections = getWorkspaceDestination(destination).sections.filter((section) => !section.hidden)
  if (permissions === undefined) return sections
  return sections.filter((section) => canOpenTab(section.tab, permissions))
}

export function resolveWorkspaceDestinationTarget(
  destination: WorkspaceDestination,
  permissions?: readonly string[],
): ActiveTab | null {
  return listWorkspaceSections(destination, permissions)[0]?.tab ?? null
}

export function canOpenWorkspaceDestination(
  destination: WorkspaceDestination,
  permissions?: readonly string[],
): boolean {
  return resolveWorkspaceDestinationTarget(destination, permissions) !== null
}
