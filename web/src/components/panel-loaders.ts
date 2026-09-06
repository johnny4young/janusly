import type { ActiveTab } from '../types'

/**
 * Dynamic importers for the tab panels that live outside the eager shell.
 * RightPanel builds its `lazy()` components from these, and the section
 * navigation preloads a panel's chunk on hover/focus so the first click into a
 * tab does not wait on the network. One importer per tab keeps every panel in
 * its own chunk (or the chunk `manualChunks` assigns it).
 */
export const panelLoaders = {
  'ai-studio': () => import('./AiStudioPanel'),
  inspector: () => import('./AuthoringPanel'),
  workflows: () => import('./WorkflowsDashboard'),
  members: () => import('./MembersPanel'),
  credentials: () => import('./ConnectionsPanel'),
  packs: () => import('./SolutionPacksPanel'),
  operations: () => import('./OperationsPage'),
  experiments: () => import('./ExperimentsPanel'),
  recover: () => import('./ActivityWorkspace'),
  runs: () => import('./RunsPanel'),
  recoveryCase: () => import('./RecoveryCasePanel'),
  reasoning: () => import('./ReasoningPanel'),
  multiAgent: () => import('../MultiAgentTimeline'),
} satisfies Partial<Record<ActiveTab, () => Promise<unknown>>>

const preloaded = new Set<string>()

/** Start fetching a tab's panel chunk; repeated calls and unknown tabs are no-ops. */
export function preloadPanel(tab: ActiveTab): void {
  const loader = (panelLoaders as Partial<Record<ActiveTab, () => Promise<unknown>>>)[tab]
  if (!loader || preloaded.has(tab)) return
  preloaded.add(tab)
  loader().catch(() => { preloaded.delete(tab) })
}
