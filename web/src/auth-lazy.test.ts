import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  createClient: vi.fn(),
}))

vi.mock('./supabase-runtime', () => ({
  createClient: runtime.createClient,
}))

afterEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  runtime.createClient.mockReset()
  vi.unstubAllEnvs()
  vi.resetModules()
})

const CALLBACK = '/#access_token=jwt-invite&refresh_token=refresh-invite&expires_in=3600&token_type=bearer'

function stubSupabaseEnv() {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-public-key')
}

function stubNoCookieSession() {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })))
}

describe('captured implicit-grant callback', () => {
  it('adopts the session once, before any caller receives the client', async () => {
    stubSupabaseEnv()
    stubNoCookieSession()
    window.history.replaceState(null, '', CALLBACK)
    let release: (() => void) | undefined
    const adopted = new Promise<void>((resolve) => { release = resolve })
    const setSession = vi.fn(async () => {
      await adopted
      return { data: { session: null, user: null }, error: null }
    })
    const getSession = vi.fn(async () => ({ data: { session: { access_token: 'jwt-invite' } } }))
    runtime.createClient.mockReturnValue({ auth: { setSession, getSession } })
    const { approveAuthCallback, captureAuthCallback } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()
    approveAuthCallback()

    const token = auth.getSupabaseAccessToken()
    const secondToken = auth.getSupabaseAccessToken()
    await vi.waitFor(() => expect(setSession).toHaveBeenCalledOnce())
    expect(getSession).not.toHaveBeenCalled()
    release?.()

    await expect(token).resolves.toBe('jwt-invite')
    await expect(secondToken).resolves.toBe('jwt-invite')
    expect(setSession).toHaveBeenCalledOnce()
    expect(setSession).toHaveBeenCalledWith({ access_token: 'jwt-invite', refresh_token: 'refresh-invite' })
  })

  it('never adopts a callback the user has not approved', async () => {
    stubSupabaseEnv()
    window.history.replaceState(null, '', CALLBACK)
    const setSession = vi.fn()
    const getSession = vi.fn(async () => ({ data: { session: null } }))
    runtime.createClient.mockReturnValue({ auth: { setSession, getSession } })
    const { captureAuthCallback } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()

    await expect(auth.getSupabaseAccessToken()).resolves.toBeNull()
    expect(setSession).not.toHaveBeenCalled()
  })

  it('resolves the identity from the auth server without loading the client', async () => {
    stubSupabaseEnv()
    window.history.replaceState(null, '', CALLBACK)
    const fetchMock = vi.fn<typeof fetch>(async (input) => (
      String(input).endsWith('/auth/session')
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ id: 'user-1', email: 'invited@example.com' }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { captureAuthCallback, pendingAuthCallbackToken } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()

    await expect(auth.resolveAuthCallbackIdentity()).resolves.toEqual({ id: 'user-1', email: 'invited@example.com' })

    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(String(url)).toBe('https://example.supabase.co/auth/v1/user')
    expect(init?.headers).toEqual({ apikey: 'anon-public-key', Authorization: 'Bearer jwt-invite' })
    expect(runtime.createClient).not.toHaveBeenCalled()
    expect(pendingAuthCallbackToken()).toBe('jwt-invite')
  })

  it.each([
    ['rejects the token', async () => new Response('{}', { status: 401 })],
    ['ended the session', async () => new Response(JSON.stringify({ error_code: 'session_not_found' }), { status: 403 })],
    ['returns no email to show', async () => new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })],
    ['returns no user id', async () => new Response(JSON.stringify({ email: 'a@example.com' }), { status: 200 })],
    ['returns malformed JSON', async () => new Response('not json', { status: 200 })],
    ['is unreachable', async () => { throw new TypeError('Failed to fetch') }],
  ])('reports a failed link when the auth server %s', async (_name, respond) => {
    stubSupabaseEnv()
    window.history.replaceState(null, '', CALLBACK)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => (
      String(input).endsWith('/auth/session') ? new Response('{}', { status: 401 }) : respond()
    )))
    const { authCallbackFailed, captureAuthCallback, pendingAuthCallbackToken } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()

    await expect(auth.resolveAuthCallbackIdentity()).resolves.toBeNull()

    expect(authCallbackFailed()).toBe(true)
    expect(pendingAuthCallbackToken()).toBeNull()
    expect(runtime.createClient).not.toHaveBeenCalled()
  })

  it('discards the callback in a build without Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    window.history.replaceState(null, '', CALLBACK)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { captureAuthCallback, pendingAuthCallbackToken } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()

    await expect(auth.resolveAuthCallbackIdentity()).resolves.toBeNull()

    expect(pendingAuthCallbackToken()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['returns an error', async () => ({ data: { session: null, user: null }, error: new Error('bad jwt') })],
    ['throws', async () => { throw new Error('network') }],
  ])('records a failure and keeps the client usable when setSession %s', async (_name, setSession) => {
    stubSupabaseEnv()
    window.history.replaceState(null, '', CALLBACK)
    const client = { auth: { setSession: vi.fn(setSession) } }
    runtime.createClient.mockReturnValue(client)
    const { approveAuthCallback, authCallbackFailed, captureAuthCallback } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()
    approveAuthCallback()

    await expect(auth.getSupabaseClient()).resolves.toBe(client)
    expect(authCallbackFailed()).toBe(true)
  })

  it('discards the callback when a cookie session outranks Supabase', async () => {
    stubSupabaseEnv()
    window.history.replaceState(null, '', CALLBACK)
    const setSession = vi.fn()
    const signOut = vi.fn(async () => ({ error: null }))
    runtime.createClient.mockReturnValue({ auth: { setSession, signOut } })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/auth/session')) {
        return new Response(JSON.stringify({
          userId: 'sso-user', email: 'sso@example.com', organizationId: 'org-sso',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    }))
    const { captureAuthCallback, pendingAuthCallbackToken } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()

    await expect(auth.resolveAuthCallbackIdentity()).resolves.toBeNull()
    expect(pendingAuthCallbackToken()).toBeNull()
    await auth.AuthProvider.signOut()

    expect(signOut).toHaveBeenCalledOnce()
    expect(setSession).not.toHaveBeenCalled()
  })

  it('does not adopt a callback that sign-out already abandoned', async () => {
    stubSupabaseEnv()
    stubNoCookieSession()
    window.history.replaceState(null, '', CALLBACK)
    const setSession = vi.fn()
    const signOut = vi.fn(async () => ({ error: null }))
    runtime.createClient.mockReturnValue({ auth: { setSession, signOut } })
    const { approveAuthCallback, captureAuthCallback } = await import('./auth-callback')
    const auth = await import('./auth')
    captureAuthCallback()
    approveAuthCallback()

    await auth.AuthProvider.signOut()

    expect(signOut).toHaveBeenCalledOnce()
    expect(setSession).not.toHaveBeenCalled()
  })
})

describe('password setup', () => {
  async function setup(authClient: Record<string, unknown>) {
    stubSupabaseEnv()
    stubNoCookieSession()
    runtime.createClient.mockReturnValue({ auth: authClient })
    const callback = await import('./auth-callback')
    const auth = await import('./auth')
    callback.markPasswordSetup('user-1')
    return { auth, marker: callback.passwordSetupUser }
  }

  const sessionFor = (id: string, email: string | undefined = 'a@example.com') => (
    vi.fn(async () => ({ data: { session: { user: { id, email } } }, error: null }))
  )

  it('is owed to the account that holds the session', async () => {
    const { auth, marker } = await setup({ getSession: sessionFor('user-1') })

    await expect(auth.resolvePasswordSetupEmail()).resolves.toBe('a@example.com')
    expect(marker()).toBe('user-1')
  })

  it.each([
    ['another account holds the session', sessionFor('user-2')],
    ['no session exists', vi.fn(async () => ({ data: { session: null }, error: null }))],
  ])('retires when %s', async (_name, getSession) => {
    const { auth, marker } = await setup({ getSession })

    await expect(auth.resolvePasswordSetupEmail()).resolves.toBeNull()
    expect(marker()).toBeNull()
  })

  it('keeps the step owed when the session cannot be read', async () => {
    const getSession = vi.fn(async () => ({ data: { session: null }, error: new Error('network') }))
    const { auth, marker } = await setup({ getSession })

    await expect(auth.resolvePasswordSetupEmail()).resolves.toBeNull()
    expect(marker()).toBe('user-1')
  })

  it('never loads the client when no step is owed', async () => {
    stubSupabaseEnv()
    const auth = await import('./auth')

    await expect(auth.resolvePasswordSetupEmail()).resolves.toBeNull()
    expect(runtime.createClient).not.toHaveBeenCalled()
  })

  it('finishes only when the password update succeeds', async () => {
    const updateUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: null }, error: { code: 'weak_password' } })
      .mockResolvedValueOnce({ data: { user: {} }, error: null })
    const { auth, marker } = await setup({ updateUser })

    await expect(auth.AuthProvider.updatePassword('short-one')).resolves.toEqual({ error: { code: 'weak_password' } })
    expect(marker()).toBe('user-1')

    await expect(auth.AuthProvider.updatePassword('long-enough')).resolves.toEqual({ error: null })
    expect(updateUser).toHaveBeenLastCalledWith({ password: 'long-enough' })
    expect(marker()).toBeNull()
  })

  it('stops being owed after a password sign-in, which proves the account has one', async () => {
    const signInWithPassword = vi.fn()
      .mockResolvedValueOnce({ data: {}, error: new Error('bad credentials') })
      .mockResolvedValueOnce({ data: {}, error: null })
    const { auth, marker } = await setup({ signInWithPassword })

    await auth.AuthProvider.signIn('a@example.com', 'wrong')
    expect(marker()).toBe('user-1')

    await auth.AuthProvider.signIn('a@example.com', 'right')
    expect(marker()).toBeNull()
  })

  it('stops being owed only after sign-out succeeds', async () => {
    const signOut = vi.fn()
      .mockResolvedValueOnce({ error: new Error('network') })
      .mockResolvedValueOnce({ error: null })
    const { auth, marker } = await setup({ signOut })

    await auth.AuthProvider.signOut()
    expect(marker()).toBe('user-1')

    await auth.AuthProvider.signOut()
    expect(marker()).toBeNull()
  })
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
