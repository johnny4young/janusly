import { act, fireEvent, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authCallbackFailed,
  captureAuthCallback,
  clearAuthCallback,
  clearPasswordSetup,
  markAuthCallbackFailed,
  markPasswordSetup,
  passwordSetupUser,
  pendingAuthCallbackToken,
  takeAuthCallbackSession,
} from '../auth-callback'
import { settleAuthCallback } from './AuthCallbackGate'

const auth = vi.hoisted(() => ({
  resolveAuthCallbackIdentity: vi.fn(),
  resolvePasswordSetupEmail: vi.fn(),
  AuthProvider: { getSession: vi.fn(), updatePassword: vi.fn(), signOut: vi.fn() },
}))
vi.mock('../auth', () => auth)

const IDENTITY = { id: 'user-1', email: 'invited@example.com' }

let host: HTMLElement
let root: Root

function captureLink(type: string) {
  window.history.replaceState(null, '', `/#access_token=jwt-a&refresh_token=jwt-r&expires_in=3600&token_type=bearer&type=${type}`)
  captureAuthCallback()
}

beforeEach(() => {
  captureLink('magiclink')
  auth.resolvePasswordSetupEmail.mockResolvedValue(null)
  auth.AuthProvider.getSession.mockResolvedValue({ data: { session: null }, error: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearAuthCallback()
  clearPasswordSetup()
  vi.clearAllMocks()
  auth.resolveAuthCallbackIdentity.mockReset()
  auth.resolvePasswordSetupEmail.mockReset()
  auth.AuthProvider.updatePassword.mockReset()
  auth.AuthProvider.signOut.mockReset()
})

async function openGate(): Promise<{ settled: Promise<void> }> {
  auth.resolveAuthCallbackIdentity.mockResolvedValue(IDENTITY)
  const settled = settleAuthCallback(root)
  await screen.findByRole('heading', { name: 'Continue as invited@example.com?' })
  return { settled }
}

async function openSetPassword(): Promise<{ settled: Promise<void> }> {
  auth.resolveAuthCallbackIdentity.mockResolvedValue(null)
  auth.resolvePasswordSetupEmail.mockResolvedValue(IDENTITY.email)
  const settled = settleAuthCallback(root)
  await screen.findByRole('heading', { name: 'Set a password' })
  expect(screen.getByText(IDENTITY.email)).toBeVisible()
  return { settled }
}

function enterPasswords(password: string, confirmation = password) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmation } })
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save password' }))

describe('settleAuthCallback', () => {
  it('renders nothing when there is no identity to approve', async () => {
    auth.resolveAuthCallbackIdentity.mockResolvedValue(null)

    await settleAuthCallback(root)

    expect(host).toBeEmptyDOMElement()
    expect(takeAuthCallbackSession()).toBeNull()
  })

  it('holds the session back until the user continues', async () => {
    const { settled } = await openGate()
    expect(takeAuthCallbackSession()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await settled

    expect(takeAuthCallbackSession()).toEqual({ access_token: 'jwt-a', refresh_token: 'jwt-r' })
  })

  it('discards the session when the user cancels, without reporting a failure', async () => {
    const { settled } = await openGate()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settled

    expect(pendingAuthCallbackToken()).toBeNull()
    expect(authCallbackFailed()).toBe(false)
    expect(auth.AuthProvider.getSession).not.toHaveBeenCalled()
  })

  it('locks the choice while the app is still loading', async () => {
    const { settled } = await openGate()
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await settled

    expect(cancel).toBeDisabled()
    fireEvent.click(cancel)
    expect(takeAuthCallbackSession()).toEqual({ access_token: 'jwt-a', refresh_token: 'jwt-r' })
  })

  it.each(['recovery', 'invite'])('owes a password after approving a %s link', async (type) => {
    captureLink(type)
    const { settled } = await openGate()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await settled

    expect(passwordSetupUser()).toBe('user-1')
  })

  it('owes no password after declining a recovery link', async () => {
    captureLink('recovery')
    const { settled } = await openGate()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settled

    expect(passwordSetupUser()).toBeNull()
  })

  it('owes no password after a magic link', async () => {
    const { settled } = await openGate()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await settled

    expect(passwordSetupUser()).toBeNull()
  })

  it('retires the step when the session could not be adopted', async () => {
    captureLink('recovery')
    auth.AuthProvider.getSession.mockImplementation(async () => {
      markAuthCallbackFailed()
      return { data: { session: null }, error: null }
    })
    auth.resolvePasswordSetupEmail.mockResolvedValue(IDENTITY.email)
    const { settled } = await openGate()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await settled

    expect(passwordSetupUser()).toBeNull()
    expect(auth.resolvePasswordSetupEmail).not.toHaveBeenCalled()
  })

  it('asks for the password once the approved session is adopted', async () => {
    captureLink('invite')
    const adopted = vi.fn()
    auth.AuthProvider.getSession.mockImplementation(async () => {
      adopted()
      return { data: { session: null }, error: null }
    })
    auth.resolvePasswordSetupEmail.mockImplementation(async () => {
      expect(adopted).toHaveBeenCalled()
      return IDENTITY.email
    })
    void (await openGate()).settled

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Set a password' })).toBeVisible()
  })
})

describe('set-password step', () => {
  it('settles after the password is saved', async () => {
    auth.AuthProvider.updatePassword.mockResolvedValue({ error: null })
    const { settled } = await openSetPassword()

    enterPasswords('correct horse')
    save()
    await settled

    expect(auth.AuthProvider.updatePassword).toHaveBeenCalledWith('correct horse')
  })

  it('names the account for password managers', async () => {
    await openSetPassword()

    expect(host.querySelector('input[autocomplete="username"]')).toHaveValue(IDENTITY.email)
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')
  })

  it('reports mismatched passwords without calling the server', async () => {
    await openSetPassword()

    enterPasswords('correct horse', 'correct house')
    save()

    expect(await screen.findByRole('alert')).toHaveTextContent("The passwords don't match.")
    expect(auth.AuthProvider.updatePassword).not.toHaveBeenCalled()
  })

  it.each([
    ['a weak password', { code: 'weak_password', status: 422 }, 'That password is too weak.'],
    ['the current password', { code: 'same_password', status: 422 }, 'Choose a password different'],
    ['an old session', { code: 'reauthentication_needed', status: 400 }, 'request a new link'],
    ['a required current password', { code: 'current_password_required', status: 400 }, 'request a new link'],
    ['an ended session', { code: 'session_not_found', status: 403 }, 'request a new link'],
    ['a missing session', { name: 'AuthSessionMissingError', status: 400 }, 'request a new link'],
    ['a dead refresh token', { code: 'refresh_token_not_found', status: 400 }, 'request a new link'],
    ['MFA enforcement', { code: 'insufficient_aal', status: 403 }, 'request a new link'],
    ['a rate limit', { code: 'over_request_rate_limit', status: 429 }, "Your password wasn't changed."],
    ['a server failure', { status: 500 }, "Your password wasn't changed."],
  ])('stays on the form with a fixed message after %s', async (_name, error, message) => {
    auth.AuthProvider.updatePassword.mockResolvedValue({ error: { ...error, message: 'Raw server text' } })
    await openSetPassword()

    enterPasswords('correct horse')
    save()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).not.toHaveTextContent('Raw server text')
    expect(screen.getByRole('button', { name: 'Save password' })).toBeEnabled()
  })

  it('lets the user retry after the request throws', async () => {
    auth.AuthProvider.updatePassword
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ error: null })
    const { settled } = await openSetPassword()

    enterPasswords('correct horse')
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent("Your password wasn't changed.")

    save()
    await settled
    expect(auth.AuthProvider.updatePassword).toHaveBeenCalledTimes(2)
  })

  it('leaves through sign-out', async () => {
    auth.AuthProvider.signOut.mockResolvedValue({ error: null })
    const { settled } = await openSetPassword()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await settled

    expect(auth.AuthProvider.updatePassword).not.toHaveBeenCalled()
  })

  it('stays when sign-out fails, so a retry can finish it', async () => {
    auth.AuthProvider.signOut
      .mockResolvedValueOnce({ error: new Error('network') })
      .mockResolvedValueOnce({ error: null })
    const { settled } = await openSetPassword()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await settled
    expect(auth.AuthProvider.signOut).toHaveBeenCalledTimes(2)
  })

  it('runs for a step still owed when no link is pending', async () => {
    clearAuthCallback()
    markPasswordSetup('user-1')
    auth.AuthProvider.signOut.mockResolvedValue({ error: null })
    const { settled } = await openSetPassword()

    expect(auth.AuthProvider.getSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await settled
  })
})
