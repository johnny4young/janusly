import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  approveAuthCallback,
  authCallbackFailed,
  authCallbackSetsPassword,
  captureAuthCallback,
  clearAuthCallback,
  clearPasswordSetup,
  markAuthCallbackFailed,
  markPasswordSetup,
  passwordSetupUser,
  pendingAuthCallbackToken,
  takeAuthCallbackSession,
} from './auth-callback'
import { readRoute } from './lib/route'

const TOKEN_FRAGMENT = '#access_token=jwt-access&refresh_token=jwt-refresh&expires_in=3600&token_type=bearer&type=invite'

function setLocation(url: string) {
  window.history.replaceState(null, '', url)
}

afterEach(() => {
  vi.restoreAllMocks()
  clearAuthCallback()
  setLocation('/')
})

describe('captureAuthCallback', () => {
  it('moves the tokens into memory and overwrites the history entry', () => {
    setLocation(`/?deadLetterId=dl-1${TOKEN_FRAGMENT}`)
    const push = vi.spyOn(window.history, 'pushState')
    const lengthBefore = window.history.length

    captureAuthCallback()

    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?deadLetterId=dl-1')
    expect(window.history.length).toBe(lengthBefore)
    expect(push).not.toHaveBeenCalled()
    expect(authCallbackFailed()).toBe(false)
    expect(pendingAuthCallbackToken()).toBe('jwt-access')
  })

  it('releases the session only after approval, and only once', () => {
    setLocation(`/${TOKEN_FRAGMENT}`)
    captureAuthCallback()

    expect(takeAuthCallbackSession()).toBeNull()
    expect(pendingAuthCallbackToken()).toBe('jwt-access')

    approveAuthCallback()
    expect(takeAuthCallbackSession()).toEqual({ access_token: 'jwt-access', refresh_token: 'jwt-refresh' })
    expect(takeAuthCallbackSession()).toBeNull()
    expect(pendingAuthCallbackToken()).toBeNull()
  })

  it.each([
    ['recovery', true],
    ['invite', true],
    ['magiclink', false],
    ['signup', false],
    ['', false],
  ])('reads link type %j as setting a password: %s', (type, expected) => {
    setLocation(`/#access_token=jwt-access&refresh_token=jwt-refresh&type=${type}`)

    captureAuthCallback()

    expect(authCallbackSetsPassword()).toBe(expected)
    clearAuthCallback()
    expect(authCallbackSetsPassword()).toBe(false)
  })

  it.each([
    ['provider error', '#error=access_denied&error_code=otp_expired&error_description=Link+expired'],
    ['bare error description', '#error_description=Link+expired'],
    ['token without a refresh token', '#access_token=jwt-access'],
    ['token alongside an error', `${TOKEN_FRAGMENT}&error=access_denied`],
  ])('removes a %s and records a failure instead of a session', (_name, fragment) => {
    setLocation(`/${fragment}`)

    captureAuthCallback()

    expect(window.location.hash).toBe('')
    expect(authCallbackFailed()).toBe(true)
    expect(pendingAuthCallbackToken()).toBeNull()
  })

  it.each(['', '#', '#/home', '#/runs/dlq/access_token=look-alike', '#section', '#foo=bar'])(
    'leaves the fragment %j alone',
    (fragment) => {
      setLocation(`/${fragment}`)
      const replace = vi.spyOn(window.history, 'replaceState')

      captureAuthCallback()

      expect(replace).not.toHaveBeenCalled()
      expect(window.location.hash).toBe(fragment === '#' ? '' : fragment)
      expect(authCallbackFailed()).toBe(false)
      expect(pendingAuthCallbackToken()).toBeNull()
    },
  )

  it('leaves the router nothing to parse', () => {
    setLocation(`/${TOKEN_FRAGMENT}`)
    captureAuthCallback()
    expect(readRoute()).toBeNull()
    expect(window.location.href).not.toContain('jwt-access')
  })

  it('still removes the tokens when replaceState is refused', () => {
    setLocation(`/${TOKEN_FRAGMENT}`)
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('Throttled', 'SecurityError')
    })
    const replace = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      hash: TOKEN_FRAGMENT,
      pathname: '/',
      search: '',
      replace,
    } as unknown as Location)

    captureAuthCallback()

    expect(replace).toHaveBeenCalledWith('#')
    expect(pendingAuthCallbackToken()).toBe('jwt-access')
  })
})

describe('clearAuthCallback', () => {
  it('drops a pending session, its approval and a recorded failure', () => {
    setLocation(`/${TOKEN_FRAGMENT}`)
    captureAuthCallback()
    approveAuthCallback()

    clearAuthCallback()
    expect(pendingAuthCallbackToken()).toBeNull()

    setLocation(`/${TOKEN_FRAGMENT}`)
    captureAuthCallback()
    expect(takeAuthCallbackSession()).toBeNull()

    markAuthCallbackFailed()
    expect(pendingAuthCallbackToken()).toBeNull()
    expect(authCallbackFailed()).toBe(true)
    clearAuthCallback()
    expect(authCallbackFailed()).toBe(false)
  })
})

describe('password setup marker', () => {
  afterEach(() => clearPasswordSetup())

  it('survives the callback state being cleared, until it is cleared itself', () => {
    markPasswordSetup('user-1')
    clearAuthCallback()
    expect(passwordSetupUser()).toBe('user-1')

    clearPasswordSetup()
    expect(passwordSetupUser()).toBeNull()
  })

  it('tolerates storage that refuses access', () => {
    const refuse = () => { throw new DOMException('Denied', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse)

    expect(() => markPasswordSetup('user-1')).not.toThrow()
    expect(() => clearPasswordSetup()).not.toThrow()
    expect(passwordSetupUser()).toBeNull()
  })
})
