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

  it('resolves the initial dev-header identity without a signed-out race', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ authenticated: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const auth = await import('./auth')

    await expect(auth.AuthProvider.getAuth()).resolves.toMatchObject({
      session: null,
      userId: 'dev-user',
      orgId: 'default',
    })
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
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/auth/session')) {
        return new Response(JSON.stringify({
          userId: 'sso-user', email: 'sso@example.com', organizationId: 'org-sso',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ signedOut: true }), { status: 200 })
    }))
    const auth = await import('./auth')

    await expect(auth.AuthProvider.getSession()).resolves.toEqual({
      data: { session: null },
      error: null,
    })
    expect(runtime.createClient).not.toHaveBeenCalled()

    await expect(auth.AuthProvider.signOut()).resolves.toEqual({ error: null })
    expect(runtime.createClient).toHaveBeenCalledOnce()
    expect(signOut).toHaveBeenCalledOnce()
    expect(auth.hasBrowserSession()).toBe(false)
  })

  it('coalesces the SSO probe before the auth listener can subscribe to Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-public-key')
    const onAuthStateChange = vi.fn()
    runtime.createClient.mockReturnValue({ auth: { onAuthStateChange } })
    let releaseProbe: (() => void) | undefined
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await probeGate
      return new Response(JSON.stringify({
        userId: 'sso-user', email: 'sso@example.com', organizationId: 'org-sso',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const auth = await import('./auth')
    const listener = vi.fn()

    const sessionPromise = auth.AuthProvider.getSession()
    const listenerPromise = auth.AuthProvider.onAuthStateChange(listener)
    releaseProbe?.()
    await Promise.all([sessionPromise, listenerPromise])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(runtime.createClient).not.toHaveBeenCalled()
    expect(onAuthStateChange).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ userId: 'sso-user', orgId: 'org-sso' }))
  })
})
