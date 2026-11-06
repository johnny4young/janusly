import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from '../auth'
import { useTestData } from '../lib/test-data'
import { useWorkflowStore } from '../store'
import { UserMenu } from './UserMenu'

const initialState = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState({
    ...initialState,
    userId: 'dev-user',
    orgId: 'default',
    authReady: true,
    identityReady: true,
    identityContext: {
      identity: { userId: 'dev-user', email: 'ada@example.com', mode: 'supabase', source: 'web' },
      profile: { name: 'Ada Operator', email: 'ada@example.com' },
      organizations: [{
        id: 'default', name: 'Acme Operations', plan: 'team', role: 'editor', roleBase: 'editor',
        permissions: ['workflows.read'], usable: true, developmentFallback: false, isOwner: false,
      }],
      invitations: [],
      currentOrganizationId: 'default',
      selectionRequired: false,
      needsOrganization: false,
      truncated: false,
      invitationsTruncated: false,
    },
    onboarding: null,
  }, true)
})

describe('<UserMenu /> docs capability', () => {
  it('shows the provider-neutral profile, organization, and actual role', () => {
    render(<UserMenu />)
    const trigger = screen.getByRole('button', { name: 'Open user menu' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(trigger)

    expect(
      screen.getByRole('dialog', { name: 'Account and workspace controls' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('Ada Operator').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Acme Operations').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Editor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument()
  })

  it('shows the build ID from the current HTML shell', () => {
    document.documentElement.dataset.buildId = '7ad05092'
    try {
      render(<UserMenu />)
      fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
      expect(screen.getByText('build 7ad05092')).toBeInTheDocument()
    } finally {
      delete document.documentElement.dataset.buildId
    }
  })

  it('closes with Escape and restores focus to the menu trigger', async () => {
    render(<UserMenu />)
    const trigger = screen.getByRole('button', { name: 'Open user menu' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Account and workspace controls' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Account and workspace controls' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open user menu' })).toHaveFocus())
  })

  it('omits the Docs item when no URL is configured', () => {
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
    expect(screen.queryByRole('link', { name: 'Docs & changelog' })).not.toBeInTheDocument()
  })

  it('omits the Docs item when the configured value is not safe HTTPS', () => {
    render(<UserMenu docsUrl="javascript:alert(1)" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
    expect(screen.queryByRole('link', { name: 'Docs & changelog' })).not.toBeInTheDocument()
  })

  it('renders a safe external Docs link when configured', () => {
    render(<UserMenu docsUrl="https://docs.example.com/start" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))

    const docs = screen.getByRole('link', { name: 'Docs & changelog' })
    expect(docs).toHaveAttribute('href', 'https://docs.example.com/start')
    expect(docs).toHaveAttribute('target', '_blank')
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('<UserMenu /> workspace switch', () => {
  it('drops pinned and mocked test data from the previous workspace', async () => {
    const context = useWorkflowStore.getState().identityContext!
    useWorkflowStore.setState({ identityContext: { ...context, organizations: [...context.organizations, { ...context.organizations[0], id: 'other', name: 'Other Org' }] } })
    useTestData.getState().setDatum('wf-1', 'fetch', { kind: 'mocked', output: 1 })
    const updateOrg = vi.spyOn(AuthProvider, 'updateOrg').mockResolvedValue({ result: {}, auth: null } as never)
    try {
      render(<UserMenu />)
      fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
      fireEvent.click(screen.getByRole('button', { name: /Other Org/ }))
      await waitFor(() => expect(updateOrg).toHaveBeenCalledWith('other'))
      await waitFor(() => expect(useTestData.getState().pins).toEqual({}))
    } finally {
      updateOrg.mockRestore()
    }
  })
})
