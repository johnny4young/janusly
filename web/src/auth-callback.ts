/**
 * One-shot hand-off of an implicit-grant callback (`#access_token=...`).
 *
 * The hash router owns the fragment and the auth client loads lazily, so the
 * callback is captured at boot. `replaceState` overwrites the navigation's own
 * history entry, and the tokens live only in this module until adopted. Nothing
 * ties a link to a sign-in this browser started, so adoption needs the user's approval.
 */

type AuthCallbackSession = { access_token: string; refresh_token: string }

let pendingSession: AuthCallbackSession | null = null
let approved = false
let failed = false

/** Run before anything can write the route. Route fragments are left alone. */
export function captureAuthCallback(): void {
  const { hash, pathname, search } = window.location
  if (hash.length < 2 || hash.startsWith('#/')) return

  const params = new URLSearchParams(hash.slice(1))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const hasError = params.has('error') || params.has('error_code') || params.has('error_description')
  if (!accessToken && !hasError) return

  try {
    window.history.replaceState(window.history.state, '', pathname + search)
  } catch {
    window.location.replace('#')
  }

  if (!hasError && accessToken && refreshToken) {
    pendingSession = { access_token: accessToken, refresh_token: refreshToken }
  } else {
    failed = true
  }
}

export function pendingAuthCallbackToken(): string | null {
  return pendingSession?.access_token ?? null
}

export function approveAuthCallback(): void {
  approved = true
}

/** Returns the session once, and only after the user approved it. */
export function takeAuthCallbackSession(): AuthCallbackSession | null {
  if (!approved) return null
  const session = pendingSession
  clearAuthCallback()
  return session
}

export function markAuthCallbackFailed(): void {
  clearAuthCallback()
  failed = true
}

export function authCallbackFailed(): boolean {
  return failed
}

export function clearAuthCallback(): void {
  pendingSession = null
  approved = false
  failed = false
}
