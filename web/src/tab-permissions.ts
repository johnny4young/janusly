/** UI visibility map for tenant permissions returned by `/auth/context`. */

import type { ActiveTab } from './types'

export const TAB_PERMISSION: Partial<Record<ActiveTab, string>> = {
  home: 'recovery.read',
  recover: 'recovery.read',
  'ai-studio': 'ai.write',
  experiments: 'evals.read',
  workflows: 'workflows.read',
  inspector: 'workflows.read',
  templates: 'workflows.read',
  packs: 'packs.read',
  marketplace: 'workflows.read',
  runs: 'runs.read',
  reasoning: 'runs.read',
  multiAgent: 'workflows.read',
  operations: 'recovery.read',
  recoveryCase: 'recovery.read',
  credentials: 'credentials.read',
  members: 'members.read',
}

export const TAB_FALLBACK_ORDER: ActiveTab[] = [
  'home',
  'workflows', 'ai-studio', 'inspector', 'templates', 'packs', 'experiments',
  'runs', 'recover', 'reasoning', 'multiAgent',
  'operations', 'credentials', 'members', 'marketplace',
]

export function canOpenTab(tab: ActiveTab, permissions: readonly string[]): boolean {
  const permission = TAB_PERMISSION[tab]
  return permission === undefined || permissions.includes(permission)
}

export function firstOpenTab(permissions: readonly string[]): ActiveTab | null {
  return TAB_FALLBACK_ORDER.find((tab) => canOpenTab(tab, permissions)) ?? null
}
