import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { pendingOAuthRequestId } from '../lib/oauth-consent'
import OAuthConsentPanel from './OAuthConsentPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const request = {
  id: '3f6c1a2e-7d1b-4c9e-9a51-0c8a6a7f2b10', clientName: 'Claude Code', redirectHost: '127.0.0.1:53211', redirectIsLocal: true,
  organizationId: 'acme',
  capabilities: [
    { capability: 'read', grantable: true, missingPermissions: [] },
    { capability: 'propose', grantable: true, missingPermissions: [] },
    { capability: 'operate', grantable: false, missingPermissions: ['runs.cancel'] },
  ],
  maxExpiresInDays: 90, defaultExpiresInDays: 30, expiresAt: '2026-11-12T10:10:00Z',
}

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset()
  window.history.replaceState(null, '', `/?oauth_request=${request.id}#/operations/access`)
})

describe('<OAuthConsentPanel />', () => {
  it('shows who asks and where the code goes, and grants only what the person ticks and can grant', async () => {
    vi.mocked(api).mockImplementation(async (path: string) =>
      path.endsWith('/decision') ? { redirectTo: 'http://127.0.0.1:53211/callback?code=c&state=s' } : request)
    const navigate = vi.fn()
    render(<OAuthConsentPanel navigate={navigate} />)
    expect(await screen.findByRole('heading', { name: 'Connect an agent?' })).toBeVisible()
    expect(screen.getByText('Claude Code')).toBeVisible()
    expect(screen.getByText('Unverified name')).toBeVisible()
    expect(screen.getByText('127.0.0.1:53211')).toBeVisible()
    expect(screen.getByText('acme')).toBeVisible()
    const operate = screen.getByRole('checkbox', { name: /Start, cancel, pause and roll back/ })
    expect(operate).toBeDisabled()
    expect(operate).not.toBeChecked()
    expect(screen.getByText('You lack runs.cancel')).toBeVisible()
    // Nothing beyond read is granted unless the person ticks it.
    const propose = screen.getByRole('checkbox', { name: 'Save workflow drafts' })
    expect(propose).not.toBeChecked()
    expect(screen.queryByText('Another server receives the code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:53211/callback?code=c&state=s'))
    const [path, init] = vi.mocked(api).mock.calls.at(-1)!
    expect(path).toBe(`/oauth/requests/${request.id}/decision`)
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ approve: true, capabilities: ['read'], expiresInDays: 30 })
  })

  it('sends a denial without capabilities, in Spanish too', async () => {
    initI18n('es')
    vi.mocked(api).mockImplementation(async (path: string) =>
      path.endsWith('/decision') ? { redirectTo: 'https://client.example/cb?error=access_denied' } : request)
    const navigate = vi.fn()
    render(<OAuthConsentPanel navigate={navigate} />)
    expect(await screen.findByText('Nombre sin verificar')).toBeVisible()
    expect(screen.getByText('(este computador)')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(JSON.parse(String((vi.mocked(api).mock.calls.at(-1)![1] as RequestInit).body))).toEqual({ approve: false })
  })

  it('warns when the code goes to another server', async () => {
    vi.mocked(api).mockResolvedValue({ ...request, redirectHost: 'client.example', redirectIsLocal: false })
    render(<OAuthConsentPanel navigate={vi.fn()} />)
    expect(await screen.findByText('Another server receives the code')).toBeVisible()
  })

  it('says when the request is gone and never navigates on a malformed answer', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('404'))
    const { unmount } = render(<OAuthConsentPanel navigate={vi.fn()} />)
    expect(await screen.findByTestId('oauth-consent-gone')).toBeVisible()
    unmount()
    vi.mocked(api).mockImplementation(async (path: string) => path.endsWith('/decision') ? { redirectTo: 42 } : request)
    const navigate = vi.fn()
    render(<OAuthConsentPanel navigate={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('The decision was not saved.')).toBeVisible()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('reads only a well-formed request id from the URL', () => {
    window.history.replaceState(null, '', `/?oauth_request=${request.id}#/operations/access`)
    expect(pendingOAuthRequestId()).toBe(request.id)
    window.history.replaceState(null, '', '/?oauth_request=../../x#/operations/access')
    expect(pendingOAuthRequestId()).toBeNull()
    const { container } = render(<OAuthConsentPanel />)
    expect(container).toBeEmptyDOMElement()
    expect(api).not.toHaveBeenCalled()
    window.history.replaceState(null, '', '/')
  })
})
