import { createClient, type Session, type User } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null

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

export function normalizeAuth(session: Session | null): NormalizedAuth {
  const user = session?.user ?? null
  return {
    session,
    user,
    userId: user?.id ?? null,
    orgId: (user?.user_metadata?.orgId as string | undefined) ?? 'default',
  }
}

export const AuthProvider = {
  signIn: (email: string, password: string) => {
    if (!supabase) return Promise.resolve({ data: { user: null, session: null }, error: null } as any)
    return supabase.auth.signInWithPassword({ email, password })
  },
  signUp: (email: string, password: string) => {
    if (!supabase) return Promise.resolve({ data: { user: null, session: null }, error: null } as any)
    return supabase.auth.signUp({ email, password })
  },
  signOut: () => {
    if (!supabase) return Promise.resolve({ error: null } as any)
    return supabase.auth.signOut()
  },
  getSession: async () => {
    if (!supabase) return { data: { session: null }, error: null } as any
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
      return { data: { subscription: { unsubscribe: () => undefined } } } as any
    }
    return supabase.auth.onAuthStateChange((_event, session) => callback(normalizeAuth(session)))
  },
}
