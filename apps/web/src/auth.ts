/**
 * Web-side auth shim. Proxies to Supabase when `VITE_SUPABASE_URL` +
 * `VITE_SUPABASE_ANON_KEY` are configured; otherwise returns a stub
 * session that mirrors the API's dev-headers mode (`org_id: default`,
 * `user_id: dev-user`).
 *
 * Active-org transport: the user's currently-selected org lives in
 * `localStorage["janusly:activeOrg"]` (NOT in Supabase `user_metadata` —
 * that claim is no longer authoritative on the API side). `api.ts`
 * reads `getActiveOrg()` on every request and ships it as `x-org-id`
 * alongside the Bearer token; the API treats this as a scope hint and
 * resolves the actual membership through `org_members` + invitations +
 * verified domains + SSO mapping.
 *
 * Used by `App.tsx`, `Login.tsx`, `MembersPanel.tsx`, `UserMenu.tsx`, and
 * `api.ts` (token + active-org injection).
 *
 * Invariants:
 * - The dev-mode shim must keep returning the same `default` / `dev-user`
 *   ids as the API expects, or the dev-headers fallback breaks.
 * - `isSupabaseConfigured` is the single source of truth for "should I
 *   render the auth UI?" — don't introduce a parallel flag.
 * - `updateOrg` writes only to localStorage. Never call
 *   `supabase.auth.updateUser({ data: { orgId } })` — the API ignores
 *   that claim.
 */

import type {
  AuthChangeEvent,
  AuthResponse,
  GoTrueClient,
  Session,
  User,
} from '@supabase/auth-js'
import {
  resumeApiRequestLifecycle,
  rotateApiRequestLifecycle,
  suspendApiRequestLifecycle,
} from './api-request-lifecycle'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001'

/** True when both Supabase env vars are present in the build. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

type SupabaseAuthFacade = { auth: GoTrueClient }

let supabaseClientPromise: Promise<SupabaseAuthFacade | null> | null = null

/**
 * Demand-load the singleton Supabase client. Dev-header builds return before
 * evaluating the dynamic import, so the vendor chunk stays off the cold path.
 */
export function getSupabaseClient(): Promise<SupabaseAuthFacade | null> {
  if (!isSupabaseConfigured) return Promise.resolve(null)
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('./supabase-runtime')
      .then(({ createClient }) => createClient(supabaseUrl!, supabaseAnonKey!))
      .catch((error: unknown) => {
        // Allow a later retry after a transient chunk-loading failure.
        supabaseClientPromise = null
        throw error
      })
  }
  return supabaseClientPromise
}

/** Resolve the current Bearer token without exposing the client to API code. */
export async function getSupabaseAccessToken(): Promise<string | null> {
  const client = await getSupabaseClient()
  if (!client) return null
  return (await client.auth.getSession()).data.session?.access_token ?? null
}

/** localStorage key carrying the user's currently-selected org. */
const ACTIVE_ORG_STORAGE_KEY = 'janusly:activeOrg'

type BrowserSessionIdentity = {
  userId: string
  email: string | null
  organizationId: string
}

let browserSessionIdentity: BrowserSessionIdentity | null = null
let browserSessionProbe: Promise<BrowserSessionIdentity | null> | null = null

function readFromStorage(key: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const value = window.localStorage.getItem(key)
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function writeToStorage(key: string, value: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable (private mode, quota); non-fatal.
  }
}

/**
 * Read the current active-org id from localStorage, falling back to
 * `"default"` so dev / unauthenticated flows still target the dev tenant.
 * `api.ts` calls this on every request and ships the value as `x-org-id`.
 */
export function getActiveOrg(): string {
  return readFromStorage(ACTIVE_ORG_STORAGE_KEY) ?? 'default'
}

/** Whether API requests should rely on the HttpOnly WorkOS cookie. */
export function hasBrowserSession(): boolean {
  return browserSessionIdentity !== null
}

async function probeBrowserSession(): Promise<BrowserSessionIdentity | null> {
  try {
    const response = await fetch(`${apiUrl}/auth/session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) {
      browserSessionIdentity = null
      return null
    }
    const payload = await response.json() as Partial<BrowserSessionIdentity>
    if (
      typeof payload.userId !== 'string'
      || typeof payload.organizationId !== 'string'
      || (payload.email !== null && typeof payload.email !== 'string')
    ) {
      browserSessionIdentity = null
      return null
    }
    browserSessionIdentity = {
      userId: payload.userId,
      email: payload.email ?? null,
      organizationId: payload.organizationId,
    }
    writeToStorage(ACTIVE_ORG_STORAGE_KEY, payload.organizationId)
    return browserSessionIdentity
  } catch {
    browserSessionIdentity = null
    return null
  }
}

/** Coalesce startup probes so the session read and auth listener choose one provider. */
function ensureBrowserSession(): Promise<BrowserSessionIdentity | null> {
  if (browserSessionIdentity) return Promise.resolve(browserSessionIdentity)
  if (!browserSessionProbe) {
    browserSessionProbe = probeBrowserSession().finally(() => {
      browserSessionProbe = null
    })
  }
  return browserSessionProbe
}

type SupabaseAuthClient = GoTrueClient
type SignOutResponse = Awaited<ReturnType<SupabaseAuthClient['signOut']>>
type SessionResponse = Awaited<ReturnType<SupabaseAuthClient['getSession']>>
type AuthSubscriptionResponse = ReturnType<SupabaseAuthClient['onAuthStateChange']>

/** Auth state the rest of the web reads. `userId` / `orgId` are the API request keys. */
export type NormalizedAuth = {
  session: Session | null
  user: User | null
  userId: string | null
  orgId: string | null
}

const devAuth: NormalizedAuth = {
  session: null,
  user: null,
  userId: 'dev-user',
  orgId: 'default',
}

const devAuthResponse: AuthResponse = {
  data: { user: null, session: null },
  error: null,
}

const devSignOutResponse: SignOutResponse = {
  error: null,
}

const devSessionResponse: SessionResponse = {
  data: { session: null },
  error: null,
}

function devAuthSubscription(): AuthSubscriptionResponse {
  return {
    data: {
      subscription: {
        id: 'dev-auth-state',
        callback: (_event: AuthChangeEvent, _session: Session | null) => undefined,
        unsubscribe: () => undefined,
      },
    },
  }
}

/**
 * Project a Supabase session onto `NormalizedAuth`. The `orgId` field
 * comes from `getActiveOrg()` (localStorage), NOT from the Supabase JWT
 * `user_metadata.orgId` claim — the API ignores that claim and resolves
 * org membership through `org_members` + invitations + verified domains
 * + SSO. Falls back to `"default"` so the dev tenant is the safe default.
 */
export function normalizeAuth(session: Session | null): NormalizedAuth {
  const user = session?.user ?? null
  const ssoIdentity = user ? null : browserSessionIdentity
  return {
    session,
    user,
    userId: user?.id ?? ssoIdentity?.userId ?? null,
    orgId: ssoIdentity?.organizationId ?? getActiveOrg(),
  }
}

/** Auth methods used by Login / UserMenu / MembersPanel. Stubs to no-ops when Supabase isn't configured. */
export const AuthProvider = {
  /**
   * Resolve the initial normalized identity through the same provider order
   * used by the live auth listener. Unlike `getSession()`, this preserves the
   * synthetic dev identity instead of projecting a null Supabase session into
   * a transient signed-out state.
   */
  getAuth: async (): Promise<NormalizedAuth> => {
    if (await ensureBrowserSession()) return normalizeAuth(null)
    const client = await getSupabaseClient()
    if (!client) return { ...devAuth, orgId: getActiveOrg() }
    const response = await client.auth.getSession()
    return normalizeAuth(response.data.session)
  },
  signIn: async (email: string, password: string) => {
    resumeApiRequestLifecycle()
    const client = await getSupabaseClient()
    if (!client) return devAuthResponse
    return client.auth.signInWithPassword({ email, password })
  },
  signUp: async (email: string, password: string) => {
    resumeApiRequestLifecycle()
    const client = await getSupabaseClient()
    if (!client) return devAuthResponse
    return client.auth.signUp({ email, password })
  },
  signOut: async () => {
    // Invalidate requests before either provider revokes its credential. A
    // panel request that resolves auth concurrently with logout must never be
    // sent with a missing or departing identity.
    suspendApiRequestLifecycle()
    if (browserSessionIdentity) {
      try {
        await fetch(`${apiUrl}/auth/session/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-janusly-csrf': '1' },
        })
      } finally {
        browserSessionIdentity = null
      }
    }
    const client = await getSupabaseClient()
    if (!client) return devSignOutResponse
    return client.auth.signOut()
  },
  getSession: async () => {
    if (await ensureBrowserSession()) return devSessionResponse
    const client = await getSupabaseClient()
    if (!client) return devSessionResponse
    return client.auth.getSession()
  },
  updateOrg: async (orgId: string) => {
    // Active-org is a client-side preference now. Writing to Supabase
    // `user_metadata.orgId` would mislead readers — the API ignores it
    // and resolves membership through `org_members`.
    if (browserSessionIdentity) {
      const response = await fetch(`${apiUrl}/auth/session/organization`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-janusly-csrf': '1' },
        body: JSON.stringify({ organizationId: orgId }),
      })
      if (!response.ok) throw new Error('Browser session could not switch organizations')
      rotateApiRequestLifecycle()
      browserSessionIdentity = { ...browserSessionIdentity, organizationId: orgId }
      writeToStorage(ACTIVE_ORG_STORAGE_KEY, orgId)
      return { result: { data: { user: null }, error: null }, auth: normalizeAuth(null) }
    }
    writeToStorage(ACTIVE_ORG_STORAGE_KEY, orgId)
    rotateApiRequestLifecycle()
    const client = await getSupabaseClient()
    if (!client) {
      devAuth.orgId = orgId
      return { result: { data: { user: null }, error: null }, auth: devAuth }
    }
    const session = await client.auth.getSession()
    return {
      result: { data: { user: session.data.session?.user ?? null }, error: null },
      auth: normalizeAuth(session.data.session),
    }
  },
  onAuthStateChange: async (callback: (auth: NormalizedAuth) => void) => {
    if (await ensureBrowserSession()) {
      callback(normalizeAuth(null))
      return devAuthSubscription()
    }
    const client = await getSupabaseClient()
    if (!client) {
      callback(devAuth)
      return devAuthSubscription()
    }
    return client.auth.onAuthStateChange((_event, session) => callback(normalizeAuth(session)))
  },
}
