import { act, fireEvent, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCallbackFailed, captureAuthCallback, clearAuthCallback, pendingAuthCallbackToken, takeAuthCallbackSession } from '../auth-callback'
import { settleAuthCallback } from './AuthCallbackGate'

const auth = vi.hoisted(() => ({ resolveAuthCallbackIdentity: vi.fn() }))
vi.mock('../auth', () => auth)

let host: HTMLElement
let root: Root

beforeEach(() => {
  window.history.replaceState(null, '', '/#access_token=jwt-a&refresh_token=jwt-r&expires_in=3600&token_type=bearer')
  captureAuthCallback()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearAuthCallback()
  auth.resolveAuthCallbackIdentity.mockReset()
})

async function openGate(): Promise<{ settled: Promise<void> }> {
  auth.resolveAuthCallbackIdentity.mockResolvedValue('invited@example.com')
  const settled = settleAuthCallback(root)
  await screen.findByRole('heading', { name: 'Continue as invited@example.com?' })
  return { settled }
}

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
})
