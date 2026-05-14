import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthProvider,
  consumeSsoSessionFragment,
  getSessionToken,
  normalizeAuth,
  setSessionToken,
} from './auth'

function makeSsoToken(input: {
  orgId: string
  userId: string
  email?: string
  expiresAt?: number
}) {
  const now = Math.floor(Date.now() / 1000)
  const envelope = {
    purpose: 'sso_session',
    payload: {
      orgId: input.orgId,
      userId: input.userId,
      email: input.email ?? 'operator@example.com',
    },
    issuedAt: now,
    expiresAt: input.expiresAt ?? now + 600,
  }
  const encoded = window.btoa(JSON.stringify(envelope))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `v1.${encoded}.signature`
}

describe('web auth SSO session handling', () => {
  afterEach(() => {
    window.localStorage.clear()
    window.history.pushState(null, '', '/')
  })

  it('consumes the SSO callback fragment, persists the token, and strips the URL hash', () => {
    const token = makeSsoToken({ orgId: 'org-sso', userId: 'user-sso' })
    window.history.pushState(null, '', `/auth/sso/complete#janusly_session=${encodeURIComponent(token)}`)

    expect(consumeSsoSessionFragment()).toBe(token)
    expect(getSessionToken()).toBe(token)
    expect(window.location.pathname).toBe('/auth/sso/complete')
    expect(window.location.hash).toBe('')
  })

  it('normalizes an API-issued SSO token as authenticated even without a Supabase session', () => {
    setSessionToken(makeSsoToken({ orgId: 'org-sso', userId: 'user-sso' }))

    expect(normalizeAuth(null)).toMatchObject({
      session: null,
      user: null,
      userId: 'user-sso',
      orgId: 'org-sso',
    })
  })

  it('clears expired SSO tokens instead of keeping the app authenticated', () => {
    setSessionToken(makeSsoToken({
      orgId: 'org-sso',
      userId: 'user-sso',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    }))

    expect(normalizeAuth(null).userId).toBeNull()
    expect(getSessionToken()).toBeNull()
  })

  it('signOut clears the Janusly SSO session token', async () => {
    setSessionToken(makeSsoToken({ orgId: 'org-sso', userId: 'user-sso' }))

    await AuthProvider.signOut()

    expect(getSessionToken()).toBeNull()
  })
})
