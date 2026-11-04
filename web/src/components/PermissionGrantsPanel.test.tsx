import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    { name: 'viewer', isBuiltin: true,  inheritsFrom: 'viewer', description: null, grantedPermissions: ['workflows.read'] },
    { name: 'editor', isBuiltin: true,  inheritsFrom: 'editor', description: null, grantedPermissions: ['workflows.read', 'workflows.write', 'dlq.replay'] },
    { name: 'admin',  isBuiltin: true,  inheritsFrom: 'admin',  description: null, grantedPermissions: ['workflows.read', 'workflows.write', 'dlq.replay', 'org.permissions.write', 'members.write'] },
  ],
}

const ROLES_WITH_CUSTOM = {
  roles: [
    ...ROLES_DEFAULT.roles,
    { name: 'compliance', isBuiltin: false, inheritsFrom: 'viewer', description: 'audit only', grantedPermissions: ['workflows.read'] },
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

function posts() {
  return vi.mocked(api).mock.calls
    .filter(([path, init]) => init?.method === 'POST' && path.startsWith('/org/roles/'))
    .map(([path, init]) => [path, JSON.parse(String(init?.body))])
}

describe('<PermissionGrantsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, toasts: [] }, true)
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

  it('derives effective built-in grants when the API uses null for catalog defaults', async () => {
    setupApi(CATALOG, {
      roles: ROLES_DEFAULT.roles.map(role => ({ ...role, grantedPermissions: null })),
    })
    render(<PermissionGrantsPanel />)

    await waitFor(() => {
      expect(screen.getByLabelText('viewer - workflows.read')).toBeChecked()
    })
    expect(screen.getByLabelText('viewer - workflows.write')).not.toBeChecked()
    expect(screen.getByLabelText('editor - workflows.write')).toBeChecked()
    expect(screen.getByLabelText('admin - org.permissions.write')).toBeChecked()
    expect(screen.getByText('5 of 5 enabled')).toBeInTheDocument()
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
    await act(async () => { fireEvent.click(screen.getByText(/Create role/)) })
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

  it('renders one matrix with a specifically named checkbox for every role and permission', async () => {
    setupApi(CATALOG, ROLES_WITH_CUSTOM)
    render(<PermissionGrantsPanel />)
    const matrix = await screen.findByTestId('permissions-matrix')
    for (const role of ['viewer', 'editor', 'admin', 'compliance']) {
      for (const { key } of CATALOG.catalog) {
        const checkbox = screen.getByLabelText(`${role} - ${key}`)
        expect(matrix).toContainElement(checkbox)
        expect(checkbox).toBe(screen.getByTestId(`permissions-toggle-${role}-${key}`))
      }
    }
    expect(matrix.querySelectorAll('input[type=checkbox]')).toHaveLength(4 * CATALOG.catalog.length)
    expect(screen.getByRole('columnheader', { name: /^viewer/ })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'dlq.replay' })).toHaveAttribute('title', 'Replay DLQ')
    expect(screen.getByTestId('permissions-add-role')).toHaveTextContent('Add custom role')
  })

  it('saves every edited role with one Save and leaves untouched roles alone', async () => {
    setupApi(CATALOG, ROLES_WITH_CUSTOM)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    expect(screen.getByTestId('permissions-save')).toBeDisabled()

    fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
    fireEvent.click(screen.getByLabelText('compliance - dlq.replay'))
    expect(screen.getByTestId('permissions-status')).toHaveTextContent('Unsaved: viewer, compliance')
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })

    expect(posts()).toEqual([
      ['/org/roles/viewer', { grantedPermissions: ['workflows.read', 'workflows.write'] }],
      ['/org/roles/compliance', { grantedPermissions: ['dlq.replay', 'workflows.read'] }],
    ])
    expect(useWorkflowStore.getState().toasts.map(toast => toast.message)).toEqual([
      'Updated permissions for "viewer, compliance"',
    ])
    expect(screen.getByTestId('permissions-save')).toBeDisabled()
    expect(screen.getByLabelText('viewer - workflows.write')).toBeChecked()
  })

  it('follows the server for a saved role instead of keeping its draft', async () => {
    let rolesResp: unknown = ROLES_DEFAULT
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/permissions/catalog') return CATALOG
      if (path === '/org/roles') return rolesResp
      if (init?.method === 'POST') return { id: 'r-viewer', grantedPermissions: ['dlq.replay', 'workflows.read'] }
      return null
    })
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('viewer - dlq.replay'))
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
    expect(screen.getByTestId('permissions-revert-viewer')).toBeInTheDocument()

    rolesResp = {
      roles: ROLES_DEFAULT.roles.map(role => role.name === 'viewer' ? { ...role, id: 'r-viewer', grantedPermissions: [] } : role),
    }
    await act(async () => { useWorkflowStore.getState().bumpPlatformVersion(['roles']) })

    await waitFor(() => expect(screen.getByLabelText('viewer - dlq.replay')).not.toBeChecked())
    expect(screen.getByTestId('permissions-save')).toBeDisabled()
  })

  it('reports partial failure, keeps the failed edit and retries only that role', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    const passthrough = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/roles/viewer' && init?.method === 'POST') {
        throw Object.assign(new Error('Forbidden'), { code: 'forbidden_for_test', error: 'Forbidden' })
      }
      return passthrough(path, init)
    })
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')

    fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
    fireEvent.click(screen.getByLabelText('editor - dlq.replay'))
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Saved 1 of 2 roles')
    expect(alert).toHaveTextContent('viewer: Forbidden')
    expect(alert).not.toHaveTextContent('editor')
    expect(useWorkflowStore.getState().toasts).toEqual([])
    expect(screen.getByTestId('permissions-status')).toHaveTextContent('Unsaved: viewer')
    expect(screen.getByTestId('permissions-status')).not.toHaveTextContent('editor')
    expect(screen.getByLabelText('viewer - workflows.write')).toBeChecked()

    vi.mocked(api).mockClear()
    vi.mocked(api).mockImplementation(passthrough)
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
    expect(posts().map(([path]) => path)).toEqual(['/org/roles/viewer'])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('attempts every role after a failure and reports when none saved', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/permissions/catalog') return CATALOG
      if (path === '/org/roles') return ROLES_DEFAULT
      if (init?.method === 'POST') throw new Error('offline')
      return null
    })
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
    fireEvent.click(screen.getByLabelText('editor - dlq.replay'))
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })

    expect(posts()).toHaveLength(2)
    expect(screen.getByRole('alert')).toHaveTextContent('Saved 0 of 2 roles')
    expect(useWorkflowStore.getState().toasts).toEqual([])
  })

  it('tints cells that differ from the built-in default and marks unsaved ones', async () => {
    setupApi(CATALOG, {
      roles: [
        { ...ROLES_DEFAULT.roles[0], id: 'r-viewer', grantedPermissions: ['workflows.read', 'dlq.replay'] },
        ROLES_DEFAULT.roles[1],
        ROLES_DEFAULT.roles[2],
        { ...ROLES_WITH_CUSTOM.roles[3], grantedPermissions: ['workflows.read', 'dlq.replay'] },
      ],
    })
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    const cell = (label: string) => screen.getByLabelText(label).closest('td')!

    expect(cell('viewer - dlq.replay')).toHaveAttribute('data-changed')
    expect(cell('viewer - dlq.replay')).not.toHaveAttribute('data-unsaved')
    expect(screen.getByLabelText('viewer - dlq.replay')).toHaveAttribute('aria-description', 'Changed from default')
    expect(cell('viewer - workflows.read')).not.toHaveAttribute('data-changed')
    // A custom role has no built-in default to differ from.
    expect(cell('compliance - dlq.replay')).not.toHaveAttribute('data-changed')
    expect(screen.getByTestId('permissions-status')).toHaveTextContent('Changes from default: 1')

    fireEvent.click(screen.getByLabelText('viewer - dlq.replay'))
    expect(cell('viewer - dlq.replay')).not.toHaveAttribute('data-changed')
    expect(cell('viewer - dlq.replay')).toHaveAttribute('data-unsaved')
    expect(screen.getByTestId('permissions-status')).toHaveTextContent('Changes from default: 0')

    fireEvent.click(screen.getByLabelText('editor - dlq.replay'))
    expect(cell('editor - dlq.replay')).toHaveAttribute('data-changed')
    expect(cell('editor - dlq.replay')).toHaveAttribute('data-unsaved')

    fireEvent.click(screen.getByLabelText('compliance - dlq.replay'))
    expect(cell('compliance - dlq.replay')).toHaveAttribute('data-unsaved')
    expect(cell('compliance - dlq.replay')).not.toHaveAttribute('data-changed')
  })

  it('treats toggling back as no change and discards edits on demand', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    const box = screen.getByLabelText('viewer - workflows.write')

    fireEvent.click(box)
    fireEvent.click(box)
    expect(screen.getByTestId('permissions-save')).toBeDisabled()

    fireEvent.click(box)
    expect(screen.getByTestId('permissions-save')).toBeEnabled()
    fireEvent.click(screen.getByTestId('permissions-discard'))
    expect(box).not.toBeChecked()
    expect(screen.getByTestId('permissions-save')).toBeDisabled()
    expect(posts()).toEqual([])
  })

  it('filters rows without dropping hidden edits from the save', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('viewer - dlq.replay'))

    const filter = screen.getByTestId('permissions-filter')
    fireEvent.change(filter, { target: { value: 'WORKFLOWS' } })
    expect(screen.getByLabelText('viewer - workflows.read')).toBeInTheDocument()
    expect(screen.queryByLabelText('viewer - dlq.replay')).not.toBeInTheDocument()
    expect(screen.getByTestId('permissions-status')).toHaveTextContent('Unsaved: viewer')

    fireEvent.change(filter, { target: { value: 'replay dlq' } })
    expect(screen.getByLabelText('viewer - dlq.replay')).toBeInTheDocument()

    fireEvent.change(filter, { target: { value: 'nothing-like-this' } })
    expect(screen.getByTestId('permissions-no-match')).toHaveTextContent('No permissions match')

    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
    expect(posts()).toEqual([['/org/roles/viewer', { grantedPermissions: ['dlq.replay', 'workflows.read'] }]])
  })

  it('keeps edits across a refetch while untouched roles follow the server', async () => {
    let rolesResp: unknown = ROLES_DEFAULT
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/org/permissions/catalog') return CATALOG
      if (path === '/org/roles') return rolesResp
      return { ok: true }
    })
    render(<PermissionGrantsPanel />)
    const matrix = await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('viewer - workflows.write'))

    let release!: (value: unknown) => void
    rolesResp = new Promise(resolve => { release = resolve })
    await act(async () => { useWorkflowStore.getState().bumpPlatformVersion(['roles']) })
    await waitFor(() => {
      expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/org/roles')).toHaveLength(2)
    })
    await act(async () => {})
    expect(screen.getByTestId('permissions-matrix')).toBe(matrix)

    await act(async () => {
      release({
        roles: ROLES_DEFAULT.roles.map(role => role.name === 'editor'
          ? { ...role, id: 'r-editor', grantedPermissions: ['workflows.read'] }
          : role),
      })
    })
    await waitFor(() => expect(screen.getByLabelText('editor - workflows.write')).not.toBeChecked())
    expect(screen.getByLabelText('viewer - workflows.write')).toBeChecked()
    expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: viewer$/)
    expect(screen.getByTestId('permissions-matrix')).toBe(matrix)
  })

  it('makes the matrix read-only without the write permission', async () => {
    setupApi(CATALOG, {
      roles: [ROLES_DEFAULT.roles[0], { ...ROLES_DEFAULT.roles[1], id: 'r-editor' }, ROLES_DEFAULT.roles[2], ROLES_WITH_CUSTOM.roles[3]],
    })
    render(<PermissionGrantsPanel canWrite={false} />)
    const matrix = await screen.findByTestId('permissions-matrix')
    for (const box of matrix.querySelectorAll('input[type=checkbox]')) expect(box).toBeDisabled()
    for (const id of ['permissions-save', 'permissions-discard', 'permissions-revert-editor', 'permissions-delete-compliance', 'permissions-add-role']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
    expect(screen.getByTestId('permissions-filter')).toBeEnabled()
  })

  it('locks the matrix while saving', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    let release!: (value: unknown) => void
    const passthrough = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise(resolve => { release = resolve }) : passthrough(path, init))
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })

    expect(screen.getByLabelText('viewer - dlq.replay')).toBeDisabled()
    expect(screen.getByTestId('permissions-save')).toBeDisabled()
    expect(screen.getByTestId('permissions-discard')).toBeDisabled()
    await act(async () => { release({ ok: true }) })
    expect(screen.getByLabelText('viewer - dlq.replay')).toBeEnabled()
  })

  it('flags an invalid new-role name inline and gates the create button', async () => {
    setupApi(CATALOG, ROLES_DEFAULT)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText('compliance')).toBeInTheDocument()
    })
    const input = screen.getByPlaceholderText('compliance')
    const createBtn = screen.getByRole('button', { name: /Create role/ })

    // Empty name → button gated.
    expect(createBtn).toBeDisabled()

    // Invalid name (space + symbol survive the lowercase normalisation).
    fireEvent.change(input, { target: { value: 'Bad Name!' } })
    expect(screen.getByText(/Role name must match/)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(createBtn).toBeDisabled()

    // Valid name → error clears, button enabled.
    fireEvent.change(input, { target: { value: 'release-manager' } })
    expect(screen.queryByText(/Role name must match/)).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(createBtn).not.toBeDisabled()
  })

  it('confirms before reverting a built-in override', async () => {
    setupApi(CATALOG, {
      roles: [
        ROLES_DEFAULT.roles[0],
        { ...ROLES_DEFAULT.roles[1], id: 'r-editor', grantedPermissions: ['workflows.read'] },
        ROLES_DEFAULT.roles[2],
      ],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<PermissionGrantsPanel />)
    await waitFor(() => {
      expect(screen.getByText('override')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('permissions-revert-viewer')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('editor - dlq.replay'))
    const revert = screen.getByRole('button', { name: 'Revert editor to defaults' })
    expect(revert).toBe(screen.getByTestId('permissions-revert-editor'))
    await act(async () => { fireEvent.click(revert) })
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/roles/editor', { method: 'DELETE' })
    })
    await waitFor(() => expect(screen.getByTestId('permissions-save')).toBeDisabled())
    confirmSpy.mockRestore()
  })

  it('deletes a custom role after confirmation and drops its edits', async () => {
    setupApi(CATALOG, ROLES_WITH_CUSTOM)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    fireEvent.click(screen.getByLabelText('compliance - dlq.replay'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete custom role compliance' })) })
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/roles/compliance', { method: 'DELETE' })
    })
    await waitFor(() => expect(screen.getByTestId('permissions-save')).toBeDisabled())
    confirmSpy.mockRestore()
  })
})
