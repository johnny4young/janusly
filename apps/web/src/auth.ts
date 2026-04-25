import { createClient, type Session, type User } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export type NormalizedAuth = {
  session: Session | null
  user: User | null
  userId: string | null
  orgId: string | null
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
  signIn: (email: string, password: string) => supabase.auth.signInWithPassword({ email, password }),
  signUp: (email: string, password: string) => supabase.auth.signUp({ email, password }),
  signOut: () => supabase.auth.signOut(),
  getSession: () => supabase.auth.getSession(),
  updateOrg: async (orgId: string) => {
    const result = await supabase.auth.updateUser({ data: { orgId } })
    const session = await supabase.auth.getSession()
    return { result, auth: normalizeAuth(session.data.session) }
  },
  onAuthStateChange: (callback: (auth: NormalizedAuth) => void) => {
    return supabase.auth.onAuthStateChange((_event, session) => callback(normalizeAuth(session)))
  },
}
