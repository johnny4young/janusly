/**
 * Build-time documentation capability.
 *
 * A docs control is rendered only when `VITE_DOCS_URL` is a credential-free
 * HTTPS URL. All three web entry points consume this one validated value so a
 * deployment cannot expose a dead or unsafe documentation affordance.
 */

export function parseDocsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return parsed.href
  } catch {
    return null
  }
}

export const DOCS_URL = parseDocsUrl(
  (import.meta as ImportMeta & { env?: { VITE_DOCS_URL?: string } }).env?.VITE_DOCS_URL,
)

/** Open a validated docs URL in an isolated tab. Returns false when invalid. */
export function openDocsUrl(
  value: unknown,
  opener: (url?: string | URL, target?: string, features?: string) => Window | null = window.open.bind(window),
): boolean {
  const docsUrl = parseDocsUrl(value)
  if (!docsUrl) return false
  const opened = opener(docsUrl, '_blank', 'noopener,noreferrer')
  if (opened) opened.opener = null
  return true
}
