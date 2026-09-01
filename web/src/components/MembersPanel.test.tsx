import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { ConfirmProvider } from './ConfirmDialog'
import { MembersPanel } from './MembersPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

function setupApi(opts: { roles?: unknown; members?: unknown[]; invitations?: unknown[] }) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/members' && (!init || init.method !== 'POST')) {
      return opts.members ?? []
    }
    if (path === '/org/roles' && (!init || init.method !== 'POST')) {
      return opts.roles ?? { roles: [
        { name: 'viewer', isBuiltin: true,  inheritsFrom: 'viewer', description: null },
        { name: 'editor', isBuiltin: true,  inheritsFrom: 'editor', description: null },
        { name: 'admin',  isBuiltin: true,  inheritsFrom: 'admin',  description: null },
      ] }
    }
    if (path === '/members/invitations' && (!init || init.method !== 'POST')) {
      return { invitations: opts.invitations ?? [] }
    }
    if (path === '/members/invite' && init?.method === 'POST') return { id: 'inv-1', status: 'pending' }
    if (/^\/members\/invitations\/[^/]+\/revoke$/.test(path) && init?.method === 'POST') return { ok: true }
    if (path === '/members/role' && init?.method === 'POST') return { ok: true }
    if (path === '/organizations/owner' && init?.method === 'POST') return { ok: true, ownerUserId: 'user-1' }
    if (path.startsWith('/members?userId=') && init?.method === 'DELETE') return { ok: true }
    return null
  })
}

describe('<MembersPanel /> dynamic role list', () => {
  beforeEach(() => {
    // Cancel any pending bumpPlatformVersion timer left by a prior
    // test so the 100ms debounce can't bleed across cases.
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({
      ...initialState,
      platformVersion: 0,
      toasts: [],
      identityContext: {
        identity: { userId: 'admin-user', email: 'admin@example.com', mode: 'supabase', source: 'web' },
        profile: { name: 'Admin', email: 'admin@example.com' },
        organizations: [{
          id: 'default',
          name: 'Default',
          plan: null,
          role: 'admin',
          roleBase: 'admin',
          permissions: ['members.read', 'members.write', 'members.role_set'],
          usable: true,
          developmentFallback: false,
          isOwner: true,
        }],
        invitations: [],
        currentOrganizationId: 'default',
        selectionRequired: false,
        needsOrganization: false,
        truncated: false,
        invitationsTruncated: false,
      },
    }, true)
  })

  it('uses the theme-aware accessible text token for the selected role', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/platform.css'), 'utf8')
    expect(css).toMatch(
      /\.we-role-option\[data-selected="true"\] \.we-role-option__name \{ color: var\(--we-primary-text\); \}/,
    )
  })

  it('populates the invite-form role dropdown with custom roles fetched from /org/roles', async () => {
    setupApi({
      roles: {
        roles: [
          { name: 'viewer', isBuiltin: true,  inheritsFrom: 'viewer', description: null },
          { name: 'editor', isBuiltin: true,  inheritsFrom: 'editor', description: null },
          { name: 'admin',  isBuiltin: true,  inheritsFrom: 'admin',  description: null },
          { name: 'compliance', isBuiltin: false, inheritsFrom: 'viewer', description: 'audit only' },
        ],
      },
    })
    render(<MembersPanel />)
    await waitFor(() => {
      // The invite role is a described radio-card group, not a <select>.
      expect(screen.getByRole('radio', { name: /compliance/i })).toBeInTheDocument()
    })
  })

  it('labels the invite target role instead of implying it is the operator role', async () => {
    setupApi({})
    render(<MembersPanel />)

    expect(await screen.findByText('Invite as Viewer')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Editor/i }))
    expect(screen.getByText('Invite as Editor')).toBeInTheDocument()
  })

  it('invites a user with a custom role name', async () => {
    setupApi({
      roles: {
        roles: [
          { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
          { name: 'compliance', isBuiltin: false, inheritsFrom: 'viewer', description: 'audit only' },
        ],
      },
    })
    render(<MembersPanel />)
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /compliance/i })).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.click(screen.getByRole('radio', { name: /compliance/i }))
    fireEvent.click(screen.getByRole('button', { name: /Invite/i }))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/members/invite',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('compliance'),
        }),
      )
    })
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })

  it('bumps platformVersion after changing a member role', async () => {
    setupApi({
      members: [{ id: 'm-1', orgId: 'default', userId: 'user-1', email: 'ada@example.com', role: 'viewer', isOwner: false }],
    })
    render(<MembersPanel />)
    await waitFor(() => {
      expect(screen.getByLabelText('Role for ada@example.com')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Role for ada@example.com'), { target: { value: 'editor' } })
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/members/role',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('editor') }),
      )
    })
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })

  it('requires inline confirmation before removing a member', async () => {
    setupApi({
      members: [{ id: 'm-1', orgId: 'default', userId: 'user-1', email: 'ada@example.com', role: 'viewer', isOwner: false }],
    })
    render(<MembersPanel />)
    await waitFor(() => {
      expect(screen.getByLabelText('Remove ada@example.com')).toBeInTheDocument()
    })
    // First click only arms the confirm — the DELETE must NOT fire yet.
    fireEvent.click(screen.getByLabelText('Remove ada@example.com'))
    expect(api).not.toHaveBeenCalledWith('/members?userId=user-1', { method: 'DELETE' })
    // Confirming fires the DELETE and bumps the platform version.
    fireEvent.click(screen.getByTestId('members-remove-confirm-user-1'))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/members?userId=user-1', { method: 'DELETE' })
    })
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })

  it('protects the owner row and confirms an explicit transfer to an admin', async () => {
    setupApi({
      members: [
        { id: 'm-owner', orgId: 'default', userId: 'admin-user', email: 'owner@example.com', role: 'admin', isOwner: true },
        { id: 'm-next', orgId: 'default', userId: 'user-1', email: 'next@example.com', role: 'admin', isOwner: false },
      ],
    })
    render(<MembersPanel />)

    expect(await screen.findByTestId('members-owner-admin-user')).toHaveTextContent('Owner')
    expect(screen.getByLabelText('Role for owner@example.com')).toBeDisabled()
    expect(screen.queryByLabelText('Remove owner@example.com')).toBeNull()

    fireEvent.click(screen.getByLabelText('Transfer ownership to next@example.com'))
    expect(api).not.toHaveBeenCalledWith('/organizations/owner', expect.anything())
    fireEvent.click(screen.getByTestId('members-transfer-confirm-user-1'))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/organizations/owner', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-1' }),
      })
    })
    await waitFor(() => {
      expect(useWorkflowStore.getState().identityContext?.organizations[0]?.isOwner).toBe(false)
    })
  })

  it('resets the invite role to viewer after a successful invite', async () => {
    setupApi({
      roles: {
        roles: [
          { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
          { name: 'admin', isBuiltin: true, inheritsFrom: 'admin', description: null },
        ],
      },
    })
    render(<MembersPanel />)
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /admin/i })).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.click(screen.getByRole('radio', { name: /admin/i }))
    expect(screen.getByRole('radio', { name: /admin/i })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /Invite/i }))
    // After the invite resolves, the role must fall back to viewer so the next
    // invite doesn't silently reuse the elevated selection.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /viewer/i })).toBeChecked()
    })
  })

  it('keeps member mutations unavailable without their effective permissions', async () => {
    setupApi({
      members: [{ id: 'm-1', orgId: 'default', userId: 'user-1', email: 'ada@example.com', role: 'viewer', isOwner: false }],
    })
    useWorkflowStore.setState((state) => ({
      identityContext: state.identityContext
        ? {
            ...state.identityContext,
            organizations: state.identityContext.organizations.map((organization) => ({
              ...organization,
              role: 'billing-admin',
              roleBase: 'admin',
              permissions: ['members.read'],
            })),
          }
        : null,
    }))

    render(<MembersPanel />)

    await waitFor(() => {
      expect(screen.getByLabelText('Role for ada@example.com')).toBeDisabled()
    })
    expect(screen.queryByLabelText('Remove ada@example.com')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Invite/i })).toBeDisabled()
    expect(screen.getByText('Member access is read-only')).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/members/invitations')).toBe(false)
  })

  it('does not advertise admin member mutations to a viewer-base custom role', async () => {
    setupApi({})
    useWorkflowStore.setState((state) => ({
      identityContext: state.identityContext
        ? {
            ...state.identityContext,
            organizations: state.identityContext.organizations.map((organization) => ({
              ...organization,
              role: 'invitation-operator',
              roleBase: 'viewer',
              permissions: ['members.read', 'members.write', 'members.role_set'],
            })),
          }
        : null,
    }))

    render(<MembersPanel />)

    expect(await screen.findByText('Member access is read-only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Invite/i })).toBeDisabled()
    expect(screen.queryByTestId('members-invitations-panel')).not.toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/members/invitations')).toBe(false)
  })

  it('shows only actionable pending invitations and preserves their bound role', async () => {
    setupApi({
      invitations: [
        {
          id: 'inv-pending',
          orgId: 'default',
          email: 'pending@example.com',
          role: 'editor',
          status: 'pending',
          createdAt: '2026-08-31T15:30:00Z',
        },
        {
          id: 'inv-accepted',
          orgId: 'default',
          email: 'accepted@example.com',
          role: 'viewer',
          status: 'accepted',
        },
        {
          id: 'inv-revoked',
          orgId: 'default',
          email: 'revoked@example.com',
          role: 'admin',
          status: 'revoked',
        },
      ],
    })

    render(<MembersPanel />)

    const pending = await screen.findByTestId('members-invitation-inv-pending')
    expect(within(pending).getByText('pending@example.com')).toBeInTheDocument()
    expect(within(pending).getByText(/Editor role/)).toBeInTheDocument()
    expect(screen.queryByText('accepted@example.com')).not.toBeInTheDocument()
    expect(screen.queryByText('revoked@example.com')).not.toBeInTheDocument()
  })

  it('requires a focus-managed confirmation before revoking a pending invitation', async () => {
    setupApi({
      invitations: [{
        id: 'inv-pending',
        orgId: 'default',
        email: 'pending@example.com',
        role: 'viewer',
        status: 'pending',
      }],
    })

    render(
      <ConfirmProvider>
        <MembersPanel />
      </ConfirmProvider>,
    )

    const trigger = await screen.findByRole('button', { name: 'Revoke invitation for pending@example.com' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke invitation' })
    expect(within(dialog).getByText(/existing link will stop working/)).toBeInTheDocument()
    expect(api).not.toHaveBeenCalledWith('/members/invitations/inv-pending/revoke', { method: 'POST' })

    fireEvent.click(within(dialog).getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/members/invitations/inv-pending/revoke', { method: 'POST' })
    })
  })

  it('shows a loading skeleton instead of flashing the members empty state', async () => {
    let resolveMembers: ((value: unknown[]) => void) | undefined
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/members') {
        return new Promise((resolve) => { resolveMembers = resolve })
      }
      if (path === '/members/invitations') return Promise.resolve({ invitations: [] })
      if (path === '/org/roles') return Promise.resolve({ roles: [] })
      return Promise.resolve(null)
    })

    render(<MembersPanel />)

    expect(await screen.findByTestId('members-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('members-empty')).not.toBeInTheDocument()

    await act(async () => { resolveMembers?.([]) })
    expect(await screen.findByTestId('members-empty')).toBeInTheDocument()
  })

  it('ignores a stale member response after the active organization changes', async () => {
    let resolveDefault: ((value: unknown[]) => void) | undefined
    let resolveSecond: ((value: unknown[]) => void) | undefined
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/members') {
        const orgId = useWorkflowStore.getState().identityContext?.currentOrganizationId
        return new Promise((resolve) => {
          if (orgId === 'second') resolveSecond = resolve
          else resolveDefault = resolve
        })
      }
      if (path === '/members/invitations') return Promise.resolve({ invitations: [] })
      if (path === '/org/roles') return Promise.resolve({ roles: [] })
      return Promise.resolve(null)
    })

    render(<MembersPanel />)
    await waitFor(() => expect(resolveDefault).toBeTypeOf('function'))

    act(() => {
      useWorkflowStore.setState((state) => ({
        identityContext: state.identityContext
          ? {
              ...state.identityContext,
              organizations: [
                ...state.identityContext.organizations,
                {
                  ...state.identityContext.organizations[0]!,
                  id: 'second',
                  name: 'Second',
                },
              ],
              currentOrganizationId: 'second',
            }
          : null,
      }))
    })
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'))

    await act(async () => {
      resolveSecond?.([{ id: 'm-second', orgId: 'second', userId: 'second-user', email: 'second@example.com', role: 'viewer', isOwner: false }])
    })
    expect(await screen.findByText('second@example.com')).toBeInTheDocument()

    await act(async () => {
      resolveDefault?.([{ id: 'm-stale', orgId: 'default', userId: 'stale-user', email: 'stale@example.com', role: 'admin', isOwner: false }])
    })
    expect(screen.queryByText('stale@example.com')).not.toBeInTheDocument()
    expect(screen.getByText('second@example.com')).toBeInTheDocument()
  })

  it('does not carry a stale custom role catalog across organizations', async () => {
    let resolveDefaultRoles: ((value: unknown) => void) | undefined
    let resolveSecondRoles: ((value: unknown) => void) | undefined
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve([])
      if (path === '/members/invitations') return Promise.resolve({ invitations: [] })
      if (path === '/org/roles') {
        const orgId = useWorkflowStore.getState().identityContext?.currentOrganizationId
        return new Promise((resolve) => {
          if (orgId === 'second') resolveSecondRoles = resolve
          else resolveDefaultRoles = resolve
        })
      }
      return Promise.resolve(null)
    })

    render(<MembersPanel />)
    await waitFor(() => expect(resolveDefaultRoles).toBeTypeOf('function'))

    act(() => {
      useWorkflowStore.setState((state) => ({
        identityContext: state.identityContext
          ? {
              ...state.identityContext,
              organizations: [
                ...state.identityContext.organizations,
                {
                  ...state.identityContext.organizations[0]!,
                  id: 'second',
                  name: 'Second',
                },
              ],
              currentOrganizationId: 'second',
            }
          : null,
      }))
    })
    await waitFor(() => expect(resolveSecondRoles).toBeTypeOf('function'))

    await act(async () => {
      resolveSecondRoles?.({
        roles: [
          { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
          { name: 'second-reviewer', isBuiltin: false, inheritsFrom: 'viewer', description: 'Second org only' },
        ],
      })
    })
    expect(await screen.findByRole('radio', { name: /second-reviewer/i })).toBeInTheDocument()

    await act(async () => {
      resolveDefaultRoles?.({
        roles: [
          { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
          { name: 'stale-admin', isBuiltin: false, inheritsFrom: 'admin', description: 'Wrong org' },
        ],
      })
    })
    expect(screen.queryByRole('radio', { name: /stale-admin/i })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /second-reviewer/i })).toBeInTheDocument()
  })
})
