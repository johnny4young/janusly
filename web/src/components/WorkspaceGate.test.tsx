import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.fn()
const updateOrg = vi.fn()
const signOut = vi.fn()

vi.mock('../api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
}))

vi.mock('../auth', () => ({
  AuthProvider: {
    updateOrg: (...args: unknown[]) => updateOrg(...args),
    signOut: (...args: unknown[]) => signOut(...args),
  },
}))

import type { SessionContext } from '../identity-context'
import { useWorkflowStore } from '../store'
import { WorkspaceGate } from './WorkspaceGate'

const initialState = useWorkflowStore.getState()

const multiOrganizationContext: SessionContext = {
  identity: { userId: 'user-1', email: 'ada@example.com', mode: 'supabase', source: 'web' },
  profile: { name: 'Ada Operator', email: 'ada@example.com' },
  organizations: [
    {
      id: 'org-a', name: 'Acme Operations', plan: 'team', role: 'admin', roleBase: 'admin',
      permissions: ['workflows.read'], usable: true, developmentFallback: false, isOwner: false,
    },
    {
      id: 'org-b', name: 'Beta Support', plan: 'free', role: 'viewer', roleBase: 'viewer',
      permissions: ['workflows.read'], usable: true, developmentFallback: false, isOwner: false,
    },
  ],
  invitations: [],
  currentOrganizationId: null,
  selectionRequired: true,
  needsOrganization: false,
  truncated: false,
  invitationsTruncated: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkflowStore.setState({
    ...initialState,
    userId: 'user-1',
    orgId: 'default',
    authReady: true,
    identityReady: true,
    identityContext: multiOrganizationContext,
  }, true)
  updateOrg.mockResolvedValue({
    auth: { session: null, user: null, userId: 'user-1', orgId: 'org-a' },
  })
  signOut.mockResolvedValue({ error: null })
})

describe('<WorkspaceGate />', () => {
  it('requires an explicit organization choice and keeps the server projection', async () => {
    render(<WorkspaceGate context={multiOrganizationContext} />)

    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Acme Operations/ }))

    await waitFor(() => expect(updateOrg).toHaveBeenCalledWith('org-a'))
    expect(useWorkflowStore.getState().identityContext?.currentOrganizationId).toBe('org-a')
  })

  it('creates the first organization with the optional profile name', async () => {
    const emptyContext: SessionContext = {
      ...multiOrganizationContext,
      organizations: [],
      currentOrganizationId: null,
      selectionRequired: false,
      needsOrganization: true,
    }
    const createdContext: SessionContext = {
      ...emptyContext,
      organizations: [multiOrganizationContext.organizations[0]!],
      currentOrganizationId: 'org-a',
      needsOrganization: false,
    }
    apiMock.mockResolvedValueOnce(createdContext)
    render(<WorkspaceGate context={emptyContext} />)

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme Operations' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme Operations', profileName: 'Ada Operator' }),
    }))
    expect(updateOrg).toHaveBeenCalledWith('org-a')
  })

  it('accepts a pending invitation before tenant bootstrap', async () => {
    const invitationContext: SessionContext = {
      ...multiOrganizationContext,
      organizations: [],
      invitations: [{
        id: 'invite-1', organizationId: 'org-a', organizationName: 'Acme Operations', role: 'editor',
      }],
      currentOrganizationId: null,
      selectionRequired: false,
      needsOrganization: true,
    }
    const joinedContext: SessionContext = {
      ...invitationContext,
      organizations: [multiOrganizationContext.organizations[0]!],
      invitations: [],
      currentOrganizationId: 'org-a',
      needsOrganization: false,
    }
    apiMock.mockResolvedValueOnce(joinedContext)
    render(<WorkspaceGate context={invitationContext} />)

    fireEvent.click(screen.getByRole('button', { name: /Acme Operations.*Accept/ }))

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ invitationId: 'invite-1' }),
    }))
  })
})
