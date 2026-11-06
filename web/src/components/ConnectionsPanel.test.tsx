import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

const spacerHeightAbove = (spacer: HTMLElement) => Number.parseInt(spacer.style.height, 10) / 48

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
  useWorkflowStore.setState({ ...initialStore }, true)
})

describe('<ConnectionsPanel />', () => {
  // The cold dialog chunk can outlast a query's timeout on a loaded machine.
  beforeAll(() => import('./connection-dialogs'))

  it('opens on searchable inventory with type, owner, expiry, and health', async () => {
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
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
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Add connection' })[0]!)
    const dialog = await screen.findByRole('dialog')
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

  it('closes the create dialog on Escape', async () => {
    render(
      <ConnectionsPanel
        credentials={[]}
        workflows={[]}
        onCreateCredential={vi.fn(async () => true)}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    const trigger = screen.getAllByRole('button', { name: 'Add connection' })[0]!
    trigger.focus()
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Connection name')).toHaveFocus())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
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
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await waitFor(() => expect(api).toHaveBeenCalledWith('/credentials/health'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Add connection' })[0]!)
    const dialog = await screen.findByRole('dialog')
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
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite={false}
      />,
    )

    await screen.findByText('pagerduty-primary')
    expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('opens the revoke dialog for the chosen row and returns focus when cancelled', async () => {
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await screen.findByText('pagerduty-primary')
    // Once the impact read settles, the typed-name field takes focus: hold it to observe the opening state.
    vi.mocked(api).mockReturnValue(new Promise(() => {}))
    const trigger = screen.getAllByRole('button', { name: 'Revoke' })[0]!
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke pagerduty-primary' })
    await waitFor(() => expect(within(dialog).getByTestId('credential-revoke-cancel')).toHaveFocus())
    expect(within(dialog).getByText(/Workflows using it will stop resolving the secret/)).toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith('/credentials/pagerduty-primary', { method: 'DELETE' })

    fireEvent.click(within(dialog).getByTestId('credential-revoke-cancel'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('keeps the first requested dialog while its chunk loads', async () => {
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await screen.findByText('pagerduty-primary')
    fireEvent.click(screen.getAllByTestId('connections-revoke')[0]!)
    fireEvent.click(screen.getAllByTestId('connections-rotate')[1]!)
    fireEvent.click(screen.getAllByTestId('connections-revoke')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))

    expect(await screen.findByRole('alertdialog', { name: 'Revoke pagerduty-primary' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('labels affected rows from the workspace workflows and hands it the confirmed revoke', async () => {
    const onRevokeCredential = vi.fn(async () => true)
    render(
      <ConnectionsPanel
        credentials={credentials}
        workflows={[{ id: 'workflow-1', name: 'Incident triage' }]}
        onCreateCredential={vi.fn(async () => true)}
        onRevokeCredential={onRevokeCredential}
        canWrite
      />,
    )

    await screen.findByText('pagerduty-primary')
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke pagerduty-primary' })
    expect(await within(dialog).findByRole('listitem')).toHaveTextContent('Incident triage')
    fireEvent.change(screen.getByTestId('credential-revoke-typed-name'), { target: { value: 'pagerduty-primary' } })
    fireEvent.click(screen.getByTestId('credential-revoke-confirm'))

    await waitFor(() => expect(onRevokeCredential).toHaveBeenCalledWith('pagerduty-primary'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
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
      // The health effect also re-runs on platformVersion. A bump that lands
      // late from a previous test's async work must not exhaust the mock: an
      // exhausted vi.fn() returns undefined and the `.then` chain throws.
      .mockRejectedValue(new Error('health unavailable'))

    const initial = [credentials[0]!]
    const { rerender } = render(
      <ConnectionsPanel
        credentials={initial}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )
    expect(await screen.findByText('Healthy')).toBeInTheDocument()

    rerender(
      <ConnectionsPanel
        credentials={[{ ...initial[0]!, id: 'other-org-credential' }]}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBeGreaterThanOrEqual(2))
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
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    const list = await screen.findByTestId('connections-virtual-list')
    expect(list).toHaveClass('we-virtual-list')
    expect(screen.getByTestId('connections-table')).toHaveAttribute('aria-rowcount', '81')

    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 240 })
    fireEvent.scroll(list, { target: { scrollTop: 960 } })
    const rows = await waitFor(() => {
      const windowed = within(list).getAllByRole('row', { hidden: true })
      expect(windowed.length).toBeLessThan(40)
      return windowed
    })
    const spacers = rows.filter((row) => row.getAttribute('aria-hidden') === 'true')
    expect(spacers).toHaveLength(2)
    const dataRows = rows.length - spacers.length - 1
    const spacerHeight = spacers.reduce((sum, row) => sum + Number.parseInt(row.style.height, 10), 0)
    expect(spacerHeight + dataRows * 48).toBe(80 * 48)
    expect(rows[1]!.nextElementSibling).toHaveAttribute('aria-rowindex', String(spacerHeightAbove(spacers[0]!) + 2))
  })

  it('shows each row as a table with known workflow usage and no secret material', async () => {
    vi.mocked(api).mockResolvedValue({
      managedStorageAvailable: true,
      credentials: [
        {
          name: 'pagerduty-primary',
          secretRefPresent: true,
          secretRef: 'SECRET_ENV_NAME',
          secretValue: 'super-secret-value',
          lastUsedAt: '2026-07-29T12:00:00.000Z',
          lastErrorAt: null,
          usageCount30d: 3,
          referencingWorkflowIds: ['workflow-1', 'workflow-gone'],
          expiresAt: '2099-08-01T00:00:00.000Z',
        },
        {
          name: 'support-slack',
          secretRefPresent: true,
          lastUsedAt: null,
          lastErrorAt: null,
          usageCount30d: 0,
          referencingWorkflowIds: [],
          expiresAt: null,
        },
      ],
    })
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[{ id: 'workflow-1', name: 'Incident triage' }]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    const table = await screen.findByRole('table', { name: 'Connections' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Name', 'Type', 'Health', 'Used by (known)', 'Last used', 'Expiry', 'Owner', 'Actions',
    ])
    expect(within(table).getByRole('columnheader', { name: 'Used by (known)' }))
      .toHaveAttribute('title', expect.stringContaining('top-level nodes only'))

    const usedBy = await screen.findAllByTestId('connections-used-by')
    expect(usedBy[0]).toHaveTextContent('2 workflows')
    expect(usedBy[0]).toHaveAttribute('title', 'Incident triage, workflow-gone')
    expect(usedBy[1]).toHaveTextContent('0 workflows')
    expect(usedBy[1]).not.toHaveAttribute('title')
    expect(within(table).getByRole('rowheader', { name: 'support-slack' })).toBeInTheDocument()
    expect(within(table).getByText('None in 30 days')).toBeInTheDocument()

    expect(screen.getAllByTestId('connections-rotate')).toHaveLength(2)
    expect(screen.getAllByTestId('connections-revoke')).toHaveLength(2)
    const panelHtml = document.body.innerHTML
    expect(panelHtml).not.toContain('SECRET_ENV_NAME')
    expect(panelHtml).not.toContain('super-secret-value')
  })

  it('summarizes secret health once health has loaded', async () => {
    vi.mocked(api).mockResolvedValue({
      managedStorageAvailable: true,
      credentials: [
        {
          name: 'pagerduty-primary',
          secretRefPresent: true,
          lastUsedAt: '2026-07-29T09:00:00.000Z',
          lastErrorAt: '2026-07-29T10:00:00.000Z',
          usageCount30d: 3,
          referencingWorkflowIds: [],
          expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        },
        {
          name: 'support-slack',
          secretRefPresent: true,
          lastUsedAt: null,
          lastErrorAt: null,
          usageCount30d: 0,
          referencingWorkflowIds: [],
          expiresAt: null,
        },
      ],
    })
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    expect(await screen.findByTestId('connections-health-summary')).toBeInTheDocument()
    expect(screen.getByTestId('connections-health-expiring')).toHaveTextContent('Expiring or expired1')
    expect(screen.getByTestId('connections-health-expiring')).toHaveClass('ui-status-summary--warning')
    expect(screen.getByTestId('connections-health-errors')).toHaveTextContent('With errors1')
    expect(screen.getByTestId('connections-health-errors')).toHaveClass('ui-status-summary--danger')
    expect(screen.getByTestId('connections-health-unused')).toHaveTextContent('Unused for 30 days1')
  })

  it('claims no health facts while health is unavailable', async () => {
    vi.mocked(api).mockRejectedValue(new Error('health unavailable'))
    render(
      <ConnectionsPanel
        credentials={credentials}
        onCreateCredential={vi.fn(async () => true)}
        workflows={[]}
        onRevokeCredential={vi.fn(async () => true)}
        canWrite
      />,
    )

    expect(await screen.findByText(/Health is temporarily unavailable/)).toBeInTheDocument()
    expect(screen.queryByTestId('connections-health-summary')).not.toBeInTheDocument()
    for (const cell of screen.getAllByTestId('connections-used-by')) expect(cell).toHaveTextContent('—')
    expect(screen.queryByText(/\d workflows?$/)).not.toBeInTheDocument()
    expect(screen.queryByText('None in 30 days')).not.toBeInTheDocument()
  })
})
