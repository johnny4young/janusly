/**
 * Web-side auth shim. Proxies to Supabase when `VITE_SUPABASE_URL` +
 * `VITE_SUPABASE_ANON_KEY` are configured; otherwise returns a stub
 * session that mirrors the API's dev-headers mode (`org_id: default`,
 * `user_id: dev-user`).
 *
 * Used by `App.tsx`, `Login.tsx`, `MembersPanel.tsx`, `UserMenu.tsx`, and
 * `api.ts` (token injection).
 *
 * Invariants:
 * - The dev-mode shim must keep returning the same `default` / `dev-user`
 *   ids as the API expects, or the dev-headers fallback breaks.
 * - `isSupabaseConfigured` is the single source of truth for "should I
 *   render the auth UI?" — don't introduce a parallel flag.
 */

import { createClient, type AuthChangeEvent, type AuthResponse, type Session, type User } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** True when both Supabase env vars are present in the build. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

/** Singleton Supabase client; `null` when env is unconfigured (dev mode). */
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null

type SupabaseAuthClient = NonNullable<typeof supabase>['auth']
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

/** Project a Supabase session onto `NormalizedAuth` (defaults `orgId` to `"default"`). */
export function normalizeAuth(session: Session | null): NormalizedAuth {
  const user = session?.user ?? null
  return {
    session,
    user,
    userId: user?.id ?? null,
    orgId: (user?.user_metadata?.orgId as string | undefined) ?? 'default',
  }
}

/** Auth methods used by Login / UserMenu / MembersPanel. Stubs to no-ops when Supabase isn't configured. */
export const AuthProvider = {
  signIn: (email: string, password: string) => {
    if (!supabase) return Promise.resolve(devAuthResponse)
    return supabase.auth.signInWithPassword({ email, password })
  },
  signUp: (email: string, password: string) => {
    if (!supabase) return Promise.resolve(devAuthResponse)
    return supabase.auth.signUp({ email, password })
  },
  signOut: () => {
    if (!supabase) return Promise.resolve(devSignOutResponse)
    return supabase.auth.signOut()
  },
  getSession: async () => {
    if (!supabase) return devSessionResponse
    return supabase.auth.getSession()
  },
  updateOrg: async (orgId: string) => {
    if (!supabase) {
      devAuth.orgId = orgId
      return { result: { data: { user: null }, error: null }, auth: devAuth }
    }
    const result = await supabase.auth.updateUser({ data: { orgId } })
    const session = await supabase.auth.getSession()
    return { result, auth: normalizeAuth(session.data.session) }
  },
  onAuthStateChange: (callback: (auth: NormalizedAuth) => void) => {
    if (!supabase) {
      callback(devAuth)
      return devAuthSubscription()
    }
    return supabase.auth.onAuthStateChange((_event, session) => callback(normalizeAuth(session)))
  },
}
