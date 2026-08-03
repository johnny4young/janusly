import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, hasBrowserSession, normalizeAuth } from './auth'

function sessionResponse(overrides: Partial<{ userId: string; email: string | null; organizationId: string }> = {}) {
  return new Response(JSON.stringify({
    userId: overrides.userId ?? 'user-sso',
    email: overrides.email === undefined ? 'operator@example.com' : overrides.email,
    organizationId: overrides.organizationId ?? 'org-sso',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('web auth HttpOnly SSO session handling', () => {
  it('probes the cookie-backed session without exposing session material to JavaScript', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sessionResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(AuthProvider.getSession()).resolves.toEqual({ data: { session: null }, error: null })
    expect(hasBrowserSession()).toBe(true)
    expect(normalizeAuth(null)).toMatchObject({ userId: 'user-sso', orgId: 'org-sso' })
    expect(window.localStorage.getItem('janusly:sessionToken')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/session'), expect.objectContaining({
      credentials: 'include',
    }))
  })

  it('rotates the server-side session organization before updating local scope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/auth/session')) return sessionResponse()
      return new Response(JSON.stringify({ organizationId: 'org-b' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await AuthProvider.getSession()

    const result = await AuthProvider.updateOrg('org-b')

    expect(result.auth).toMatchObject({ userId: 'user-sso', orgId: 'org-b' })
    expect(window.localStorage.getItem('janusly:activeOrg')).toBe('org-b')
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/auth/session/organization'), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'x-janusly-csrf': '1' }),
      body: JSON.stringify({ organizationId: 'org-b' }),
    }))
  })

  it('revokes the server session and clears in-memory identity on sign-out', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/auth/session')) return sessionResponse()
      return new Response(JSON.stringify({ signedOut: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await AuthProvider.getSession()

    await AuthProvider.signOut()

    expect(hasBrowserSession()).toBe(false)
    expect(normalizeAuth(null).userId).toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/auth/session/logout'), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { 'x-janusly-csrf': '1' },
    }))
  })
})
