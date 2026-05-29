import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { MembersPanel } from './MembersPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

function setupApi(opts: { roles?: unknown; members?: unknown[] }) {
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
    if (path === '/members/invite' && init?.method === 'POST') return { id: 'inv-1', status: 'pending' }
    if (path === '/members/role' && init?.method === 'POST') return { ok: true }
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
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
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
      members: [{ id: 'm-1', orgId: 'default', userId: 'user-1', email: 'ada@example.com', role: 'viewer' }],
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

  it('bumps platformVersion after removing a member', async () => {
    setupApi({
      members: [{ id: 'm-1', orgId: 'default', userId: 'user-1', email: 'ada@example.com', role: 'viewer' }],
    })
    render(<MembersPanel />)
    await waitFor(() => {
      expect(screen.getByLabelText('Remove ada@example.com')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Remove ada@example.com'))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/members?userId=user-1', { method: 'DELETE' })
    })
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })
})
