import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import es from '../i18n/locales/es/common.json'
import { useWorkflowStore } from '../store'
import { PermissionGrantsPanel } from './PermissionGrantsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

// The matrix is a large DOM: on a busy host its queries outlast the default wait budgets.
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

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

function toastMessages() {
  return useWorkflowStore.getState().toasts.map(toast => toast.message)
}

function apiError(message: string, code: string, params?: Record<string, unknown>) {
  return Object.assign(new Error(message), { error: message, code, params })
}

// Role writes wait for the test to release them; reads and deletes answer at once.
function deferRoleWrites(rolesResp: unknown) {
  const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = []
  vi.mocked(api).mockImplementation((path: string) => {
    if (path === '/org/permissions/catalog') return Promise.resolve(CATALOG)
    if (path === '/org/roles') return Promise.resolve(rolesResp)
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
  })
  return pending
}

describe('<PermissionGrantsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, toasts: [] }, true)
  })

  afterEach(() => {
    localStorage.removeItem('janusly:activeOrg')
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
    const addRole = screen.getByTestId('permissions-add-role')
    expect(addRole).toHaveTextContent('Add custom role')
    expect(addRole.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(addRole)
    expect(addRole.closest('details')).toHaveAttribute('open')
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
    const remove = screen.getByRole('button', { name: 'Delete custom role compliance' })
    expect(remove).toBe(screen.getByTestId('permissions-delete-compliance'))
    await act(async () => { fireEvent.click(remove) })
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/roles/compliance', { method: 'DELETE' })
    })
    await waitFor(() => expect(screen.getByTestId('permissions-save')).toBeDisabled())
    confirmSpy.mockRestore()
  })

  describe('when the workspace changes during a save', () => {
    async function startTwoRoleSave() {
      localStorage.setItem('janusly:activeOrg', 'org-a')
      const pending = deferRoleWrites(ROLES_DEFAULT)
      const view = render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
      fireEvent.click(screen.getByLabelText('editor - members.write'))
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
      expect(posts().map(([path]) => path)).toEqual(['/org/roles/viewer'])
      return { pending, view }
    }

    it('stops before writing the remaining roles into the new workspace', async () => {
      const { pending } = await startTwoRoleSave()
      localStorage.setItem('janusly:activeOrg', 'org-b')
      await act(async () => { pending[0].resolve({ ok: true }) })

      expect(posts().map(([path]) => path)).toEqual(['/org/roles/viewer'])
      expect(toastMessages()).toEqual([
        'Save stopped because the workspace or view changed. Saved: viewer. Not confirmed: editor.',
      ])
      expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: editor$/)
      expect(screen.getByTestId('permissions-save')).toBeEnabled()
    })

    it('does not claim a write aborted by the switch was saved', async () => {
      const { pending } = await startTwoRoleSave()
      localStorage.setItem('janusly:activeOrg', 'org-b')
      await act(async () => { pending[0].reject(new DOMException('Identity changed', 'AbortError')) })

      expect(posts()).toHaveLength(1)
      expect(toastMessages()).toEqual([
        'Save stopped because the workspace or view changed. Saved: —. Not confirmed: viewer, editor.',
      ])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('stops when the panel unmounts', async () => {
      const { pending, view } = await startTwoRoleSave()
      view.unmount()
      await act(async () => { pending[0].resolve({ ok: true }) })

      expect(posts()).toHaveLength(1)
      expect(toastMessages()).toEqual([
        'Save stopped because the workspace or view changed. Saved: viewer. Not confirmed: editor.',
      ])
    })

    it('reports success when every role was already written', async () => {
      localStorage.setItem('janusly:activeOrg', 'org-a')
      const pending = deferRoleWrites(ROLES_DEFAULT)
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
      localStorage.setItem('janusly:activeOrg', 'org-b')
      await act(async () => { pending[0].resolve({ ok: true }) })

      expect(toastMessages()).toEqual(['Updated permissions for "viewer"'])
    })

    it('never carries edits into the next workspace', async () => {
      setupApi(CATALOG, ROLES_DEFAULT)
      const identity = (id: string) => ({ currentOrganizationId: id }) as ReturnType<typeof useWorkflowStore.getState>['identityContext']
      useWorkflowStore.setState({ identityContext: identity('org-a') })
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
      expect(screen.getByTestId('permissions-save')).toBeEnabled()

      await act(async () => { useWorkflowStore.setState({ identityContext: identity('org-b') }) })

      expect(await screen.findByLabelText('viewer - workflows.write')).not.toBeChecked()
      expect(screen.getByTestId('permissions-save')).toBeDisabled()
    })
  })

  it.each(['constructor', '__proto__'])('keeps working with a custom role named %s', async (name) => {
    setupApi(CATALOG, {
      roles: [...ROLES_DEFAULT.roles, { name, isBuiltin: false, inheritsFrom: 'viewer', description: null, grantedPermissions: null }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    const box = screen.getByLabelText(`${name} - dlq.replay`)
    expect(box).not.toBeChecked()
    expect(screen.getByTestId('permissions-save')).toBeDisabled()

    fireEvent.click(box)
    expect(box).toBeChecked()
    expect(screen.getByTestId('permissions-status')).toHaveTextContent(`Unsaved: ${name}`)
    await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
    expect(posts()).toEqual([[`/org/roles/${name}`, { grantedPermissions: ['dlq.replay'] }]])

    await act(async () => { fireEvent.click(screen.getByTestId(`permissions-delete-${name}`)) })
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/org/roles/${name}`, { method: 'DELETE' }))
    confirmSpy.mockRestore()
  })

  describe('drafts that match the server', () => {
    function serveRoles(initial: unknown) {
      const state = { rolesResp: initial }
      vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/org/permissions/catalog') return CATALOG
        if (path === '/org/roles') return state.rolesResp
        return { ok: true }
      })
      return state
    }
    const withViewerGrants = (grantedPermissions: string[]) => ({
      roles: ROLES_DEFAULT.roles.map(role => role.name === 'viewer' ? { ...role, id: 'r-viewer', grantedPermissions } : role),
    })
    const refetch = () => act(async () => { useWorkflowStore.getState().bumpPlatformVersion(['roles']) })

    it('follows another admin after a toggle back instead of overwriting them', async () => {
      const server = serveRoles(ROLES_DEFAULT)
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      const box = screen.getByLabelText('viewer - workflows.write')
      fireEvent.click(box)
      fireEvent.click(box)

      server.rolesResp = withViewerGrants(['workflows.read', 'dlq.replay'])
      await refetch()

      await waitFor(() => expect(screen.getByLabelText('viewer - dlq.replay')).toBeChecked())
      expect(screen.getByTestId('permissions-save')).toBeDisabled()
      expect(screen.getByTestId('permissions-status')).not.toHaveTextContent('Unsaved')
    })

    it('drops a draft once a refetch makes it match, so a later change still shows', async () => {
      const server = serveRoles(ROLES_DEFAULT)
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - dlq.replay'))

      server.rolesResp = withViewerGrants(['workflows.read', 'dlq.replay'])
      await refetch()
      await waitFor(() => expect(screen.getByTestId('permissions-save')).toBeDisabled())

      server.rolesResp = withViewerGrants(['workflows.read'])
      await refetch()
      await waitFor(() => expect(screen.getByLabelText('viewer - dlq.replay')).not.toBeChecked())
      expect(screen.getByTestId('permissions-save')).toBeDisabled()
    })
  })

  describe('partial-failure alert', () => {
    async function failViewerSave() {
      setupApi(CATALOG, { roles: [ROLES_DEFAULT.roles[0], { ...ROLES_DEFAULT.roles[1], id: 'r-editor' }, ROLES_DEFAULT.roles[2]] })
      const passthrough = vi.mocked(api).getMockImplementation()!
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === '/org/roles/viewer' && init?.method === 'POST') throw new Error('Forbidden')
        return passthrough(path, init)
      })
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - workflows.write'))
      fireEvent.click(screen.getByLabelText('editor - members.write'))
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-save')) })
      expect(screen.getByRole('alert')).toHaveTextContent('viewer: Forbidden')
    }

    it('goes away when the failed edit is toggled back and stays away on a new edit', async () => {
      await failViewerSave()
      const box = screen.getByLabelText('viewer - workflows.write')
      fireEvent.click(box)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      fireEvent.click(box)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('goes away on discard', async () => {
      await failViewerSave()
      fireEvent.click(screen.getByTestId('permissions-discard'))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('stays while the failed role is unsaved even if another role is reverted', async () => {
      await failViewerSave()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-revert-editor')) })
      await waitFor(() => expect(api).toHaveBeenCalledWith('/org/roles/editor', { method: 'DELETE' }))
      await waitFor(() => expect(toastMessages()).toEqual(['Reverted "editor" to defaults']))
      expect(screen.getByRole('alert')).toHaveTextContent('viewer: Forbidden')
      expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: viewer$/)
      confirmSpy.mockRestore()
    })
  })

  describe('failures outside Save', () => {
    function failing(method: string, path: string, error: Error, rolesResp: unknown = ROLES_WITH_CUSTOM) {
      setupApi(CATALOG, rolesResp)
      const passthrough = vi.mocked(api).getMockImplementation()!
      vi.mocked(api).mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === path && init?.method === method) throw error
        return passthrough(url, init)
      })
    }

    it('shows a create failure translated, at the form, and keeps the input', async () => {
      failing('POST', '/org/roles', apiError('role with this name already exists', 'role_already_exists', { name: 'taken' }))
      render(<PermissionGrantsPanel />)
      const input = await screen.findByPlaceholderText('compliance')
      fireEvent.change(input, { target: { value: 'taken' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create role/ })) })

      const form = input.closest('form')!
      expect(within(form).getByRole('alert')).toHaveTextContent('A role named "taken" already exists')
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(input).toHaveValue('taken')
      expect(toastMessages()).toEqual([])

      vi.mocked(api).mockImplementation(async () => ({ id: 'r-new' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create role/ })) })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps edits and tells the operator when a revert fails', async () => {
      failing('DELETE', '/org/roles/editor', new Error('revert refused'), {
        roles: [ROLES_DEFAULT.roles[0], { ...ROLES_DEFAULT.roles[1], id: 'r-editor' }, ROLES_DEFAULT.roles[2]],
      })
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('editor - members.write'))
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-revert-editor')) })

      await waitFor(() => expect(toastMessages()).toEqual(['revert refused']))
      expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: editor$/)
      expect(screen.getByLabelText('editor - members.write')).toBeChecked()
      confirmSpy.mockRestore()
    })

    it('keeps the role and its edits when delete answers role_in_use', async () => {
      failing('DELETE', '/org/roles/compliance', apiError('cannot delete a role with active members', 'role_in_use', { membersAffected: 2 }))
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('compliance - dlq.replay'))
      await act(async () => { fireEvent.click(screen.getByTestId('permissions-delete-compliance')) })

      await waitFor(() => expect(toastMessages()).toEqual(['Cannot delete this role — 2 member(s) still use it']))
      expect(screen.getByTestId('permissions-role-compliance')).toBeInTheDocument()
      expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: compliance$/)
      expect(screen.getByLabelText('compliance - dlq.replay')).toBeChecked()
      confirmSpy.mockRestore()
    })

    it('shows a translated load failure without an empty matrix or create form', async () => {
      vi.mocked(api).mockImplementation(async () => { throw apiError('raw server text', 'role_in_use', { membersAffected: 2 }) })
      render(<PermissionGrantsPanel />)

      expect(await screen.findByRole('alert')).toHaveTextContent('Cannot delete this role — 2 member(s) still use it')
      expect(screen.queryByText('Loading permissions…')).not.toBeInTheDocument()
      expect(screen.queryByTestId('permissions-matrix')).not.toBeInTheDocument()
      expect(screen.queryByTestId('permissions-add-role')).not.toBeInTheDocument()
    })

    it('keeps the matrix and edits through a failed refetch and recovers on the next one', async () => {
      let rolesFail = false
      vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/org/permissions/catalog') return CATALOG
        if (rolesFail) throw new Error('refetch failed')
        return ROLES_DEFAULT
      })
      render(<PermissionGrantsPanel />)
      await screen.findByTestId('permissions-matrix')
      fireEvent.click(screen.getByLabelText('viewer - workflows.write'))

      rolesFail = true
      await act(async () => { useWorkflowStore.getState().bumpPlatformVersion(['roles']) })
      expect((await screen.findByText('refetch failed')).closest('[role="alert"]')).not.toBeNull()
      expect(screen.getByTestId('permissions-matrix')).toBeInTheDocument()
      expect(screen.getByLabelText('viewer - workflows.write')).toBeChecked()
      expect(screen.getByTestId('permissions-status')).toHaveTextContent(/Unsaved: viewer$/)

      rolesFail = false
      await act(async () => { useWorkflowStore.getState().bumpPlatformVersion(['roles']) })
      await waitFor(() => expect(screen.queryByText('refetch failed')).not.toBeInTheDocument())
      expect(screen.getByLabelText('viewer - workflows.write')).toBeChecked()
    })
  })

  it('words the Spanish copy without an English term or a broken singular', () => {
    expect(es['permissions.savePartial'].replace('{{saved}}', '1').replace('{{total}}', '2')).toBe('Roles guardados: 1 de 2')
    expect(es['permissions.add.inheritOption.viewer']).toBe('viewer (recomendado)')
  })

  it('names unsaved cells for screen readers, not only with an outline', async () => {
    setupApi(CATALOG, ROLES_WITH_CUSTOM)
    render(<PermissionGrantsPanel />)
    await screen.findByTestId('permissions-matrix')
    const custom = screen.getByLabelText('compliance - dlq.replay')
    const builtin = screen.getByLabelText('viewer - dlq.replay')
    expect(custom).not.toHaveAttribute('aria-description')

    fireEvent.click(custom)
    expect(custom).toHaveAttribute('aria-description', 'Unsaved')
    fireEvent.click(custom)
    expect(custom).not.toHaveAttribute('aria-description')

    fireEvent.click(builtin)
    expect(builtin).toHaveAttribute('aria-description', 'Changed from default. Unsaved')
  })
})
