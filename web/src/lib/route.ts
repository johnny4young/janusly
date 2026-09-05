/**
 * The workspace URL. The shell keeps its state in the store; this module is
 * the only place that knows how that state spells itself in the hash, so
 * every link is shareable and the browser's back button means something.
 *
 *   #/<tab>                       a workspace tab
 *   #/recoveryCase/<caseId>       one recovery case
 *   #/runs/dlq                    the recovery queue, heading focused
 *   #/runs/dlq/<deadLetterId>     the recovery queue focused on one failure
 *   #/runs/day/<YYYY-MM-DD>       the recovery queue filtered to one UTC day
 *   #/operations/<section>        one Operations sub-section
 *
 * Hash routing keeps the served bundle a single static document: no server
 * rewrite, no path the API could shadow. `?deadLetterId=` from alert
 * notifications stays a supported alias of the dlq form.
 */
import type { ActiveTab } from '../types'

export const ROUTE_TABS = [
  'home', 'recover', 'workflows', 'members', 'ai-studio', 'experiments', 'marketplace', 'templates',
  'packs', 'credentials', 'inspector', 'runs', 'reasoning', 'multiAgent', 'operations', 'recoveryCase',
] as const satisfies readonly ActiveTab[]

// A tab added to ActiveTab without a spelling here fails to compile.
type UnroutedTab = Exclude<ActiveTab, (typeof ROUTE_TABS)[number]>
const routesCoverEveryTab: UnroutedTab extends never ? true : never = true
void routesCoverEveryTab

export type WorkspaceRoute = {
  tab: ActiveTab
  recoveryCaseId?: string
  queueFocus?: boolean
  deadLetterId?: string
  focusDay?: string
  opsSection?: string
}

/** Fired after this module writes the route, so mounted consumers see
 *  in-app navigation the way they see browser navigation. */
export const ROUTE_EVENT = 'janusly:route'

const MAX_SEGMENT = 256
const DAY = /^\d{4}-\d{2}-\d{2}$/

function isTab(value: string): value is ActiveTab {
  return (ROUTE_TABS as readonly string[]).includes(value)
}

function segment(raw: string | undefined): string | null {
  if (raw === undefined) return null
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    return null
  }
  value = value.trim()
  return value.length > 0 && value.length <= MAX_SEGMENT ? value : null
}

/** Parse a location hash. Anything not spelled above is `null`, never a guess. */
export function parseRoute(hash: string): WorkspaceRoute | null {
  if (!hash.startsWith('#/')) return null
  const [tab, kind, ...rest] = hash.slice(2).split('/')
  if (!tab || !isTab(tab)) return null
  // A recovery case is only addressable with its id.
  if (kind === undefined) return rest.length === 0 && tab !== 'recoveryCase' ? { tab } : null
  if (kind === '') return null
  if (tab === 'recoveryCase' && rest.length === 0) {
    const id = segment(kind)
    return id ? { tab, recoveryCaseId: id } : null
  }
  if (tab === 'runs' && kind === 'dlq' && rest.length === 0) return { tab, queueFocus: true }
  if (tab === 'runs' && rest.length === 1) {
    const id = segment(rest[0])
    if (!id) return null
    if (kind === 'dlq') return { tab, deadLetterId: id }
    if (kind === 'day') return DAY.test(id) ? { tab, focusDay: id } : null
    return null
  }
  if (tab === 'operations' && rest.length === 0) {
    const section = segment(kind)
    return section ? { tab, opsSection: section } : null
  }
  return null
}

export function formatRoute(route: WorkspaceRoute): string {
  if (route.tab === 'recoveryCase' && route.recoveryCaseId) return `#/recoveryCase/${encodeURIComponent(route.recoveryCaseId)}`
  if (route.tab === 'runs' && route.deadLetterId) return `#/runs/dlq/${encodeURIComponent(route.deadLetterId)}`
  if (route.tab === 'runs' && route.queueFocus) return '#/runs/dlq'
  if (route.tab === 'runs' && route.focusDay) return `#/runs/day/${route.focusDay}`
  if (route.tab === 'operations' && route.opsSection) return `#/operations/${encodeURIComponent(route.opsSection)}`
  return `#/${route.tab}`
}

export function readRoute(): WorkspaceRoute | null {
  if (typeof window === 'undefined') return null
  return parseRoute(window.location.hash)
}

/** Write the route. `push` creates a history entry (a navigation the back
 *  button undoes); `replace` rewrites the current one (a refinement). */
export function writeRoute(route: WorkspaceRoute, mode: 'push' | 'replace' = 'push'): void {
  if (typeof window === 'undefined') return
  const hash = formatRoute(route)
  if (window.location.hash === hash) return
  try {
    const url = window.location.pathname + window.location.search + hash
    if (mode === 'replace') window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
  } catch {
    window.location.hash = hash
  }
  window.dispatchEvent(new CustomEvent(ROUTE_EVENT, { detail: route }))
}

/** Subscribe to route changes: browser navigation and in-app writes alike. */
export function onRouteChange(listener: (route: WorkspaceRoute | null) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = () => listener(readRoute())
  window.addEventListener('popstate', handler)
  window.addEventListener('hashchange', handler)
  window.addEventListener(ROUTE_EVENT, handler)
  return () => {
    window.removeEventListener('popstate', handler)
    window.removeEventListener('hashchange', handler)
    window.removeEventListener(ROUTE_EVENT, handler)
  }
}
