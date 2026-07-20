import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  createClient: vi.fn(),
}))

vi.mock('./supabase-runtime', () => ({
  createClient: runtime.createClient,
}))

afterEach(() => {
  window.localStorage.clear()
  runtime.createClient.mockReset()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('demand-loaded Supabase auth', () => {
  it('does not evaluate the Supabase runtime in dev-header mode', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    const auth = await import('./auth')

    expect(auth.isSupabaseConfigured).toBe(false)
    await expect(auth.getSupabaseClient()).resolves.toBeNull()
    await expect(auth.getSupabaseAccessToken()).resolves.toBeNull()
    expect(runtime.createClient).not.toHaveBeenCalled()
  })

  it('creates one configured client lazily and reuses it for token reads', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-public-key')
    const getSession = vi.fn(async () => ({
      data: { session: { access_token: 'jwt-operator' } },
    }))
    const client = { auth: { getSession } }
    runtime.createClient.mockReturnValue(client)
    const auth = await import('./auth')

    expect(auth.isSupabaseConfigured).toBe(true)
    await expect(auth.getSupabaseClient()).resolves.toBe(client)
    await expect(auth.getSupabaseAccessToken()).resolves.toBe('jwt-operator')
    await expect(auth.getSupabaseClient()).resolves.toBe(client)
    expect(runtime.createClient).toHaveBeenCalledOnce()
    expect(runtime.createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-public-key',
    )
    expect(getSession).toHaveBeenCalledOnce()
  })

  it('keeps SSO bootstrap lightweight but clears a stale Supabase session on sign-out', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-public-key')
    const signOut = vi.fn(async () => ({ error: null }))
    runtime.createClient.mockReturnValue({ auth: { signOut } })
    const auth = await import('./auth')
    auth.setSessionToken('sso-session-token')

    await expect(auth.AuthProvider.getSession()).resolves.toEqual({
      data: { session: null },
      error: null,
    })
    expect(runtime.createClient).not.toHaveBeenCalled()

    await expect(auth.AuthProvider.signOut()).resolves.toEqual({ error: null })
    expect(runtime.createClient).toHaveBeenCalledOnce()
    expect(signOut).toHaveBeenCalledOnce()
    expect(auth.getSessionToken()).toBeNull()
  })
})
