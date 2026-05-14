import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { PermissionGrantsPanel } from './PermissionGrantsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

const CATALOG = {
  catalog: [
    { key: 'workflows.read',  category: 'workflows', description: 'View workflows',  defaultRoles: ['viewer', 'editor', 'admin'] },
    { key: 'workflows.write', category: 'workflows', description: 'Save workflows',  defaultRoles: ['editor', 'admin'] },
    { key: 'dlq.replay',      category: 'dlq',       description: 'Replay DLQ',      defaultRoles: ['editor', 'admin'] },
    { key: 'org.permissions.write', category: 'org', description: 'Manage permissions', defaultRoles: ['admin'] },
    { key: 'members.write',   category: 'members',   description: 'Manage members',  defaultRoles: ['admin'] },
  ],
  mandatoryAdminPermissions: ['org.permissions.write', 'members.write'],
}

const ROLES_DEFAULT = {
  roles: [
    { name: 'viewer', isBuiltin: true,  inheritsFrom: 'viewer', description: null, grantedPermissions: ['workflows.read'], isOverride: false },
    { name: 'editor', isBuiltin: true,  inheritsFrom: 'editor', description: null, grantedPermissions: ['workflows.read', 'workflows.write', 'dlq.replay'], isOverride: false },
    { name: 'admin',  isBuiltin: true,  inheritsFrom: 'admin',  description: null, grantedPermissions: ['workflows.read', 'workflows.write', 'dlq.replay', 'org.permissions.write', 'members.write'], isOverride: false },
  ],
}

const ROLES_WITH_CUSTOM = {
  roles: [
    ...ROLES_DEFAULT.roles,
    { name: 'compliance', isBuiltin: false, inheritsFrom: 'viewer', description: 'audit only', grantedPermissions: ['workflows.read'], isOverride: false },
  ],
}

function setupApi(catalogResp: unknown, rolesResp: unknown) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/org/permissions/catalog') return catalogResp
    if (path === '/org/roles' && (!init || init.method !== 'POST')) return rolesResp
    if (path === '/org/roles' && init?.method === 'POST') return { id: 'r-new' }
    if (path.startsWith('/org/roles/') && init?.method === 'DELETE') return { ok: true }
    if (path.startsWith('/org/roles/') && init?.method === 'POST') return { ok: true }
    return null
  })
}

describe('<PermissionGrantsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders all three built-ins with no overrides', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    const { container } = render(<PermissionGrantsPanel />)
    await waitFor(() => {
      const codes = container.querySelectorAll('code')
      const names = Array.from(codes).map((el) => el.textContent)
      expect(names).toContain('viewer')
      expect(names).toContain('editor')
      expect(names).toContain('admin')
    })
  })

  it('renders a custom role alongside built-ins', async () => {
    setupApi(CATALOG, ROLES_WITH_CUSTOM)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByText('compliance')).toBeInTheDocument()
    })
    expect(screen.getByText(/inherits viewer/)).toBeInTheDocument()
  })

  it('disables the mandatory admin permissions on the admin built-in row', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByLabelText('admin - org.permissions.write')).toBeInTheDocument()
    })
    const adminFloorCheckbox = screen.getByLabelText('admin - org.permissions.write') as HTMLInputElement
    expect(adminFloorCheckbox.disabled).toBe(true)
  })

  it('submits an attach form to create a custom role', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText('compliance')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByPlaceholderText('compliance'), { target: { value: 'release-manager' } })
    // Toggle one permission for the new role
    fireEvent.click(screen.getByLabelText('new-role-workflows.read'))
    fireEvent.click(screen.getByText(/Create role/))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/org/roles',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('release-manager'),
        }),
      )
    })
  })

  it('saves a built-in override via the per-role Save button', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByLabelText('editor - workflows.write')).toBeInTheDocument()
    })
    const saveButtons = screen.getAllByRole('button', { name: /^Save$/ })
    expect(saveButtons.length).toBeGreaterThan(0)
    fireEvent.click(saveButtons[0])
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        expect.stringMatching(/^\/org\/roles\//),
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('confirms before reverting a built-in override', async () => {
    setupApi(CATALOG, {
      roles: [
        ROLES_DEFAULT.roles[0],
        { ...ROLES_DEFAULT.roles[1], grantedPermissions: ['workflows.read'], isOverride: true },
        ROLES_DEFAULT.roles[2],
      ],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByText('override')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText(/Revert to defaults/))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/roles/editor', { method: 'DELETE' })
    })
    confirmSpy.mockRestore()
  })
})
