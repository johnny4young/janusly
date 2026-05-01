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

import { supabase } from './auth'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

/** Make an authenticated request to the API; resolves the parsed body or throws on non-2xx. */
export async function api(path: string, options: RequestInit = {}) {
  const session = supabase ? await supabase.auth.getSession() : { data: { session: null } }
  const token = session.data.session?.access_token

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!token ? { 'x-org-id': 'default', 'x-user-id': 'dev-user' } : {}),
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
    const message = typeof payload?.error === 'string' ? payload.error : `Request failed with ${res.status}`
    throw new Error(message)
  }

  return payload
}
