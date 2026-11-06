/**
 * Cross-component bus for the Operations sub-section
 * (overview plus seven focused settings areas), spelled as the route
 * `#/operations/<section>`.
 *
 * Lives in its own tiny module so deep-linkers (BudgetBlockedBanner,
 * UserMenu) can request a section WITHOUT statically importing the heavy
 * `OperationsPage` (+ its 11 admin sub-panels). That keeps OperationsPage
 * code-splittable via `React.lazy` — a static import of `requestOperationsSection`
 * from OperationsPage would otherwise pull the whole panel back into the
 * main chunk.
 *
 * Callers import from this bus rather than pulling the lazy settings page
 * into the main workspace chunk.
 */
import { useSyncExternalStore } from 'react'
import { onRouteChange, readRoute, writeRoute } from '../lib/route'

/** Closed-enum sub-section value shared by the Settings index, deep links,
 *  persisted navigation, and the active-only panel dispatcher. */
export const OPERATIONS_SUB_SECTIONS = [
  'overview',
  'organization',
  'reliability',
  'integrations',
  'access',
  'ai',
  'usage',
  'infrastructure',
] as const
export type OpsSection = typeof OPERATIONS_SUB_SECTIONS[number]

const STORAGE_KEY = 'janusly:operations:section'

export function isOpsSection(value: unknown): value is OpsSection {
  return typeof value === 'string' && (OPERATIONS_SUB_SECTIONS as readonly string[]).includes(value)
}

/** The section the URL names, else the last one the operator was on. */
export function loadStoredOpsSection(): OpsSection {
  const route = readRoute()
  if (route?.tab === 'operations' && isOpsSection(route.opsSection)) return route.opsSection
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && isOpsSection(raw)) return raw
  } catch {
    // private mode / quota errors / non-browser exec; fall through.
  }
  return 'overview'
}

/** Remember the section and, while Operations is the open tab, spell it in
 *  the URL so the link is shareable. */
export function persistOpsSection(section: OpsSection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, section)
  } catch {
    // ignore; persistence is convenience, not load-bearing.
  }
  if (readRoute()?.tab === 'operations') writeRoute({ tab: 'operations', opsSection: section }, 'replace')
}

/** Deep-link into an Operations sub-section from anywhere. The route write is
 *  the request: the mounted OperationsPage follows it, a later mount reads it. */
export function requestOperationsSection(section: OpsSection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, section)
  } catch {
    // ignore
  }
  writeRoute({ tab: 'operations', opsSection: section })
}

function routeOpsSection(): OpsSection | null {
  const route = readRoute()
  return route?.tab === 'operations' && isOpsSection(route.opsSection) ? route.opsSection : null
}

/** The pane the URL names, for the shell breadcrumb outside the lazy page. */
export function useRouteOpsSection(): OpsSection | null {
  return useSyncExternalStore(onRouteChange, routeOpsSection)
}
