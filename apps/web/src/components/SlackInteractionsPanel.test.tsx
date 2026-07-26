import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { SlackInteractionsPanel } from './SlackInteractionsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const connection = {
  id: 'f36c0018-ae36-4d96-96c2-c7ed81669e9e',
  name: 'Recovery operations',
  teamId: 'T123',
  signingCredentialName: 'slack-signing',
  userMappings: [{ slackUserId: 'U123', userId: 'member-1' }],
  enabled: true,
  callbackUrl: '/webhooks/slack/interactions/f36c0018-ae36-4d96-96c2-c7ed81669e9e',
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ platformVersion: 0 })
})

describe('<SlackInteractionsPanel />', () => {
  it('renders a safe connection projection with callback and mapping count', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/integrations/slack/interactions') return { connections: [connection] }
      if (path === '/credentials') return [{ id: 'credential-1', name: 'slack-signing', kind: 'slack_signing_secret' }]
      if (path === '/members') return [{ userId: 'member-1', email: 'ops@example.com', role: 'editor' }]
      return null
    })

    render(<SlackInteractionsPanel />)

    const row = await screen.findByTestId(`slack-interaction-${connection.id}`)
    expect(within(row).getByText('Recovery operations')).toBeInTheDocument()
    expect(within(row).getByText(/1 mapped operator/)).toBeInTheDocument()
    expect(within(row).getByText(connection.callbackUrl)).toBeInTheDocument()
    expect(row.textContent).not.toContain('secretRef')
  })

  it('creates a bounded mapping from a Slack user to an organization member', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/integrations/slack/interactions' && init?.method === 'POST') return { connection }
      if (path === '/integrations/slack/interactions') return { connections: [] }
      if (path === '/credentials') return [
        { id: 'credential-1', name: 'slack-signing', kind: 'slack_signing_secret' },
        { id: 'credential-2', name: 'incoming-webhook', kind: 'slack_webhook' },
      ]
      if (path === '/members') return [{ userId: 'member-1', email: 'ops@example.com', role: 'editor' }]
      return null
    })

    render(<SlackInteractionsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New connection' }))
    const form = screen.getByTestId('slack-interaction-form')
    fireEvent.change(within(form).getByLabelText('Connection name'), { target: { value: 'Recovery operations' } })
    fireEvent.change(within(form).getByLabelText('Slack team ID'), { target: { value: 'T123' } })
    fireEvent.change(within(form).getByLabelText('Signing-secret credential'), { target: { value: 'slack-signing' } })
    expect(within(within(form).getByLabelText('Signing-secret credential')).queryByText('incoming-webhook')).toBeNull()
    fireEvent.change(within(form).getByLabelText('Slack user ID, mapping 1'), { target: { value: 'U123' } })
    fireEvent.change(within(form).getByLabelText('Janusly member, mapping 1'), { target: { value: 'member-1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create connection' }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/integrations/slack/interactions', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Recovery operations',
          teamId: 'T123',
          signingCredentialName: 'slack-signing',
          userMappings: [{ slackUserId: 'U123', userId: 'member-1' }],
          enabled: true,
        }),
      })
    })
  })

  it('blocks duplicate Slack user mappings before the request', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/integrations/slack/interactions') return { connections: [] }
      if (path === '/credentials') return [{ id: 'credential-1', name: 'slack-signing', kind: 'slack_signing_secret' }]
      if (path === '/members') return [{ userId: 'member-1' }, { userId: 'member-2' }]
      return null
    })
    render(<SlackInteractionsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add user mapping' }))
    fireEvent.change(screen.getByLabelText('Slack user ID, mapping 1'), { target: { value: 'U123' } })
    fireEvent.change(screen.getByLabelText('Janusly member, mapping 1'), { target: { value: 'member-1' } })
    fireEvent.change(screen.getByLabelText('Slack user ID, mapping 2'), { target: { value: 'U123' } })
    fireEvent.change(screen.getByLabelText('Janusly member, mapping 2'), { target: { value: 'member-2' } })
    expect(screen.getByText('Each Slack user ID can be mapped only once.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create connection' })).toBeDisabled()
  })

  it('rejects malformed API rows instead of trusting partial arrays', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/integrations/slack/interactions') {
        return {
          connections: [
            { ...connection, userMappings: [{ slackUserId: 7, userId: 'member-1' }] },
            null,
          ],
        }
      }
      if (path === '/credentials') return [null, { kind: 'slack_signing_secret' }]
      if (path === '/members') return [null, { userId: 42 }]
      return null
    })

    render(<SlackInteractionsPanel />)

    expect(await screen.findByTestId('slack-interactions-empty')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New connection' }))
    expect(screen.getByLabelText('Signing-secret credential')).toHaveValue('')
    expect(screen.getByLabelText('Janusly member, mapping 1')).toHaveValue('')
  })
})
