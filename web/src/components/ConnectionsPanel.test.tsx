import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { Credential } from '../types'
import { ConnectionsPanel } from './ConnectionsPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const credentials: Credential[] = [
  {
    id: 'cred-1',
    name: 'pagerduty-primary',
    kind: 'pagerduty_api_token',
    storage: 'managed',
    createdBy: 'operator@example.com',
    expiresAt: '2099-08-01T00:00:00.000Z',
  },
  {
    id: 'cred-2',
    name: 'support-slack',
    kind: 'slack_webhook',
    storage: 'environment',
    createdBy: 'platform@example.com',
  },
]

const initialStore = useWorkflowStore.getState()

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({
    managedStorageAvailable: true,
    credentials: [
      {
        name: 'pagerduty-primary',
        secretRefPresent: true,
        lastUsedAt: '2026-07-29T12:00:00.000Z',
        lastErrorAt: null,
        usageCount30d: 3,
        referencingWorkflowIds: ['workflow-1'],
        expiresAt: '2099-08-01T00:00:00.000Z',
      },
      {
        name: 'support-slack',
        secretRefPresent: false,
        lastUsedAt: null,
        lastErrorAt: null,
        usageCount30d: 0,
        referencingWorkflowIds: [],
        expiresAt: null,
      },
    ],
  })
  useWorkflowStore.setState({ ...initialStore, platformVersion: 0 }, true)
})

describe('<ConnectionsPanel />', () => {
  it('opens on searchable inventory with type, owner, expiry, and health', async () => {
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    const inventory = await screen.findByTestId('connections-virtual-list')
    expect(within(inventory).getByText('pagerduty-primary')).toBeInTheDocument()
    expect(within(inventory).getByText('operator@example.com')).toBeInTheDocument()
    expect(within(inventory).getByText('Healthy')).toBeInTheDocument()
    expect(within(inventory).getByText('Missing')).toBeInTheDocument()
    expect(within(inventory).getByText(/2099/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Secret value')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search by name, type, or owner…'), {
      target: { value: 'platform@' },
    })
    expect(screen.queryByText('pagerduty-primary')).not.toBeInTheDocument()
    expect(screen.getByText('support-slack')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter connections by type'), {
      target: { value: 'pagerduty_api_token' },
    })
    expect(screen.getByText('No connections match')).toBeInTheDocument()
  })

  it('creates a managed connection in a focused write-only dialog', async () => {
    const onCreateCredential = vi.fn(async () => true)
    render(
      <ConnectionsPanel
        credentials={[]}
        onCreateCredential={onCreateCredential}
        canWrite
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Add connection' })[0]!)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/paste once; it will not be shown again/i)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Connection name'), {
      target: { value: 'anthropic-primary' },
    })
    fireEvent.change(within(dialog).getByLabelText('Connection kind'), {
      target: { value: 'generic' },
    })
    fireEvent.change(within(dialog).getByLabelText('Secret value'), {
      target: { value: 'secret-value' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add connection' }))

    await waitFor(() => {
      expect(onCreateCredential).toHaveBeenCalledWith({
        name: 'anthropic-primary',
        kind: 'generic',
        secretValue: 'secret-value',
      })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByDisplayValue('secret-value')).not.toBeInTheDocument()
  })

  it('offers a usable first-credential path when managed storage has no root key', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      credentials: [],
      mcpConnections: [],
      managedStorageAvailable: false,
    })
    render(
      <ConnectionsPanel
        credentials={[]}
        onCreateCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await waitFor(() => expect(api).toHaveBeenCalledWith('/credentials/health'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Add connection' })[0]!)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Secret storage')).toHaveValue('environment')
    expect(within(dialog).getByRole('option', { name: /Managed by Janusly \(unavailable\)/i })).toBeDisabled()
    expect(within(dialog).getByText(/JANUSLY_CREDENTIAL_MASTER_KEY/)).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'external_runtime_signing_secret' })).toBeInTheDocument()
  })

  it('keeps mutations absent for credential readers', async () => {
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        canWrite={false}
      />,
    )

    await screen.findByText('pagerduty-primary')
    expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('refreshes health when an equal-sized inventory comes from a new scope', async () => {
    vi.mocked(api)
      .mockReset()
      .mockResolvedValueOnce({
        credentials: [{
          name: 'pagerduty-primary',
          secretRefPresent: true,
          lastUsedAt: null,
          lastErrorAt: null,
          usageCount30d: 0,
          referencingWorkflowIds: [],
          expiresAt: null,
        }],
      })
      .mockRejectedValueOnce(new Error('health unavailable'))

    const initial = [credentials[0]!]
    const { rerender } = render(
      <ConnectionsPanel
        credentials={initial}
        onCreateCredential={vi.fn(async () => true)}
        canWrite
      />,
    )
    expect(await screen.findByText('Healthy')).toBeInTheDocument()

    rerender(
      <ConnectionsPanel
        credentials={[{ ...initial[0]!, id: 'other-org-credential' }]}
        onCreateCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Health is temporarily unavailable/)).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument()
  })

  it('uses the bounded virtual-list contract for long inventories', async () => {
    const many = Array.from({ length: 80 }, (_, index): Credential => ({
      id: `cred-${index}`,
      name: `connection-${index}`,
      kind: index % 2 === 0 ? 'generic' : 'postgres',
      storage: 'managed',
      createdBy: 'operator@example.com',
    }))
    render(
      <ConnectionsPanel
        credentials={many}
        onCreateCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    const list = await screen.findByTestId('connections-virtual-list')
    expect(list).toHaveClass('we-virtual-list')
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '80')
  })
})
