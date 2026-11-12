import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { AgentActivityPanel } from './AgentActivityPanel'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
})

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ sessions: [], nextCursor: null })
  window.history.replaceState(null, '', '/#/multiAgent')
})

describe('<AgentActivityPanel />', () => {
  it('switches between the run timeline and observed sessions through the URL', async () => {
    render(<AgentActivityPanel events={[]} canReadSessions />)
    expect(screen.getByRole('button', { name: 'Run timeline' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Agent sessions' }))
    expect(await screen.findByText('No agent sessions yet')).toBeVisible()
    expect(window.location.hash).toBe('#/multiAgent/sessions')
    fireEvent.click(screen.getByRole('button', { name: 'Run timeline' }))
    expect(window.location.hash).toBe('#/multiAgent')
  })

  it('offers no sessions without runs.read, even from a shared link', () => {
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    render(<AgentActivityPanel events={[]} canReadSessions={false} />)
    expect(screen.queryByRole('button', { name: 'Agent sessions' })).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })
})
