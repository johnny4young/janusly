/**
 * Cross-component bus for the Operations sub-section
 * (overview plus six focused settings areas).
 *
 * Lives in its own tiny module so deep-linkers (BudgetBlockedBanner,
 * UserMenu) can request a section WITHOUT statically importing the heavy
 * `OperationsPage` (+ its 11 admin sub-panels). That keeps OperationsPage
 * code-splittable via `React.lazy` — a static import of `requestOperationsSection`
 * from OperationsPage would otherwise pull the whole panel back into the
 * main chunk.
 *
 * `OperationsPage` re-exports `requestOperationsSection` for back-compat;
 * new callers should import from here.
 */

/** Closed-enum sub-section value shared by the Settings index, deep links,
 *  persisted navigation, and the active-only panel dispatcher. */
export const OPERATIONS_SUB_SECTIONS = [
  'overview',
  'reliability',
  'integrations',
  'access',
  'ai',
  'usage',
  'infrastructure',
] as const
export type OpsSection = typeof OPERATIONS_SUB_SECTIONS[number]

const STORAGE_KEY = 'janusly:operations:section'
export const OPERATIONS_SECTION_REQUEST_EVENT = 'janusly:operations:section-request'

export function isOpsSection(value: unknown): value is OpsSection {
  return typeof value === 'string' && (OPERATIONS_SUB_SECTIONS as readonly string[]).includes(value)
}

export function loadStoredOpsSection(): OpsSection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && isOpsSection(raw)) return raw
  } catch {
    // private mode / quota errors / non-browser exec; fall through.
  }
  return 'overview'
}

export function persistOpsSection(section: OpsSection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, section)
  } catch {
    // ignore; persistence is convenience, not load-bearing.
  }
}

/** Deep-link into an Operations sub-section from anywhere (persists + emits
 *  the request event the mounted OperationsPage listens for). */
export function requestOperationsSection(section: OpsSection): void {
  persistOpsSection(section)
  window.dispatchEvent(new CustomEvent(OPERATIONS_SECTION_REQUEST_EVENT, { detail: section }))
}
