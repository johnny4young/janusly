/**
 * Typed `fetch` wrapper for the Janusly API. Auto-injects either the
 * Supabase JWT (when a session exists) or the dev-headers fallback
 * (`x-org-id: default` / `x-user-id: dev-user`). Falls offline-cleanly
 * when the API isn't reachable, surfacing a user-friendly message.
 *
 * Used by every async data path in `apps/web/src` (App.tsx, store.ts,
 * components/*).
 *
 * Invariants:
 * - Dev-header values match `apps/api/src/auth.ts`'s expected
 *   header names. Don't drift.
 * - JSON body assumed; binary uploads aren't supported here.
 */

import { getActiveOrg, getSessionToken, supabase } from './auth'
import { useWorkflowStore } from './store'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

/**
 * Make an authenticated request to the API; resolves the parsed body or
 * throws on non-2xx.
 *
 * Exception: `POST /start` and `POST /resume` 400 responses whose body matches
 * `{ errors: string[] }` are resolved (not thrown) and returned as-is.
 * This is the field-level validation envelope the API emits when a workflow
 * declares typed `inputs` and the payload doesn't satisfy them — the
 * run-input form needs to surface those errors next to the right field
 * rather than losing them in a toast. Other 400 bodies still throw.
 */
export async function api(path: string, options: RequestInit = {}) {
  // SSO-issued Janusly session token wins over Supabase JWT — when the
  // user logged in via WorkOS, the callback set this localStorage entry
  // and the API's `extractJanuslySession` provider reads it as the 4th
  // auth mode.
  const sessionToken = getSessionToken()
  const session = !sessionToken && supabase
    ? await supabase.auth.getSession()
    : { data: { session: null } }
  const token = session.data.session?.access_token

  // `x-org-id` ships on every request — it's the scope hint the API
  // resolver uses to pick a membership when the user belongs to multiple
  // orgs. In dev mode (no Supabase / no SSO) it's the authoritative org.
  // In Supabase mode it's an untrusted hint — the API resolves the actual
  // grant through `org_members`. With an SSO session, the token's
  // signed payload already carries orgId.
  const headers = {
    'Content-Type': 'application/json',
    'x-org-id': getActiveOrg(),
    ...(sessionToken ? { 'x-janusly-session': sessionToken } : {}),
    ...(!sessionToken && token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!sessionToken && !token ? { 'x-user-id': 'dev-user' } : {}),
    ...(options.headers ?? {})
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers })
  } catch {
    throw new Error('Janusly API is offline. Start the API and refresh this view.')
  }
  const payload = await res.json().catch(() => ({}))

  if (!res.ok) {
    if ((path === '/start' || path === '/resume') && res.status === 400 && isFieldErrorEnvelope(payload)) {
      return payload
    }
    // AI cost budget block — surface the envelope in the store so the
    // top-of-canvas BudgetBlockedBanner can render. We still throw so the
    // calling code's error-handling path runs; the banner is an additive
    // signal alongside the toast / inline error.
    if (res.status === 402 && payload && typeof payload === 'object' && 'budget' in payload) {
      try {
        const setter = useWorkflowStore.getState().setBudgetBlocked
        setter((payload as { budget?: unknown }).budget as Parameters<typeof setter>[0])
      } catch {
        // Non-fatal — the throw below still surfaces the original 402.
      }
    }
    const message = typeof payload?.error === 'string' ? payload.error : `Request failed with ${res.status}`
    throw new Error(message)
  }

  return payload
}

function isFieldErrorEnvelope(value: unknown): value is { errors: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { errors?: unknown }).errors) &&
    (value as { errors: unknown[] }).errors.every((entry) => typeof entry === 'string')
  )
}

/**
 * Download a file from the API using the same auth resolution as
 * `api()`. The API's `Content-Disposition: attachment; filename=...`
 * header carries the suggested filename; if the caller passes
 * `filename`, it overrides that. The Blob + anchor click pattern
 * sidesteps the browser's "open in tab" default for text MIME types.
 */
export async function downloadFromApi(path: string, filename?: string): Promise<void> {
  const sessionToken = getSessionToken()
  const session = !sessionToken && supabase
    ? await supabase.auth.getSession()
    : { data: { session: null } }
  const token = session.data.session?.access_token

  const headers = {
    'x-org-id': getActiveOrg(),
    ...(sessionToken ? { 'x-janusly-session': sessionToken } : {}),
    ...(!sessionToken && token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!sessionToken && !token ? { 'x-user-id': 'dev-user' } : {}),
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { headers })
  } catch {
    throw new Error('Janusly API is offline. Start the API and refresh this view.')
  }

  if (!res.ok) {
    let errorMessage = `Download failed with ${res.status}`
    try {
      const payload = await res.json()
      if (typeof payload?.error === 'string') errorMessage = payload.error
    } catch {
      // Not JSON — keep the generic message.
    }
    throw new Error(errorMessage)
  }

  const blob = await res.blob()

  // Prefer caller-supplied filename. Otherwise read from
  // Content-Disposition: prefer the RFC 5987 `filename*=UTF-8''<encoded>`
  // form (carries non-ASCII names safely), fall back to the plain
  // `filename="..."` ASCII variant. The server's `Access-Control-Expose-Headers`
  // setting is what makes this header readable from JS — without it
  // the browser hides cross-origin response headers and this helper
  // falls through to the generic 'download.bin' name.
  let resolvedFilename = filename
  if (!resolvedFilename) {
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
    if (utf8Match?.[1]) {
      try {
        resolvedFilename = decodeURIComponent(utf8Match[1])
      } catch {
        resolvedFilename = utf8Match[1]
      }
    } else {
      const asciiMatch = /filename="([^"]+)"/.exec(disposition)
      resolvedFilename = asciiMatch?.[1]
    }
    if (!resolvedFilename) resolvedFilename = 'download.bin'
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = resolvedFilename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}
