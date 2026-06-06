import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { ScimDirectorySettingsPanel } from './ScimDirectorySettingsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

const ROW_EXAMPLE = {
  id: 'sd-1',
  orgId: 'org-a',
  providerDirectoryId: 'directory_01_test',
  directoryType: 'okta_scim',
  defaultRole: 'editor' as const,
  status: 'active' as const,
  lastSyncedAt: '2026-05-14T12:00:00Z',
  createdAt: null,
  updatedAt: null,
}

/**
 * Wire the mocked `api` as a tiny router over the three GET reads the
 * panel issues in parallel (directories / mappings / groups) plus the
 * mutation routes. Every GET resolves to a real array so the panel's
 * `Promise.all` never sees an undefined (the production `api` always
 * returns a Promise).
 */
function mockApi(opts: {
  directories?: unknown[]
  mappings?: unknown[]
  groups?: unknown[]
} = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (path === '/org/scim/directories' && method === 'GET') return opts.directories ?? []
    if (path === '/org/scim/group-role-mappings' && method === 'GET') return opts.mappings ?? []
    if (path === '/org/scim/groups' && method === 'GET') return opts.groups ?? []
    if (path === '/org/scim/directories' && method === 'POST') return { id: 'sd-new' }
    if (path.startsWith('/org/scim/directories/') && method === 'DELETE') return { ok: true }
    if (path === '/org/scim/group-role-mappings' && method === 'POST') return { id: 'm-new' }
    if (path.startsWith('/org/scim/group-role-mappings/') && method === 'POST') return { id: 'm-1' }
    if (path.startsWith('/org/scim/group-role-mappings/') && method === 'DELETE') return { ok: true }
    if (path === '/org/scim/resync' && method === 'POST') return { membersResynced: 3, membersChanged: 1, skipped: 0, capped: false, changes: [] }
    return []
  })
}

describe('<ScimDirectorySettingsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the connect form when no directory exists', async () => {
    mockApi({ directories: [] })
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByPlaceholderText(/directory_01…/)).toBeInTheDocument()
    expect(screen.getByText(/Connect directory/)).toBeInTheDocument()
  })

  it('renders the directory row when one is attached and hides the form', async () => {
    mockApi({ directories: [ROW_EXAMPLE] })
    render(<ScimDirectorySettingsPanel />)
    await waitFor(() => {
      expect(screen.getByText('directory_01_test')).toBeInTheDocument()
    })
    expect(screen.getByText('editor')).toBeInTheDocument()
    expect(screen.getByText('okta_scim')).toBeInTheDocument()
    // No connect form
    expect(screen.queryByPlaceholderText(/directory_01…/)).not.toBeInTheDocument()
    // Disconnect button visible
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument()
  })

  it('submits the attach form with trimmed values', async () => {
    mockApi({ directories: [] })
    render(<ScimDirectorySettingsPanel />)
    const idInput = await screen.findByPlaceholderText(/directory_01…/)
    fireEvent.change(idInput, { target: { value: '  directory_test  ' } })
    fireEvent.change(screen.getByPlaceholderText(/okta_scim, azure_scim/), { target: { value: 'azure_scim' } })
    fireEvent.click(screen.getByRole('button', { name: /Connect directory/i }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/org/scim/directories',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            providerDirectoryId: 'directory_test',
            directoryType: 'azure_scim',
            defaultRole: 'viewer',
          }),
        }),
      )
    })
  })

  it('confirms before revoking and calls the DELETE route', async () => {
    mockApi({ directories: [ROW_EXAMPLE] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<ScimDirectorySettingsPanel />)
    const button = await screen.findByRole('button', { name: /Disconnect/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/scim/directories/sd-1', { method: 'DELETE' })
    })
    confirmSpy.mockRestore()
  })

  // === Group → role mappings ===

  it('hides the mappings section when no active directory is attached', async () => {
    mockApi({ directories: [] })
    render(<ScimDirectorySettingsPanel />)
    await screen.findByPlaceholderText(/directory_01…/)
    expect(screen.queryByText(/Group → role mappings/i)).not.toBeInTheDocument()
  })

  it('shows the no-synced-groups empty state when groups have not synced yet', async () => {
    mockApi({ directories: [ROW_EXAMPLE], groups: [], mappings: [] })
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByText(/Group → role mappings/i)).toBeInTheDocument()
    expect(screen.getByText(/No synced groups yet/i)).toBeInTheDocument()
  })

  it('renders existing mappings with the group name and its role', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }],
    })
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByText('Engineering')).toBeInTheDocument()
    const roleSelect = screen.getByLabelText('Role for Engineering') as HTMLSelectElement
    expect(roleSelect.value).toBe('editor')
  })

  it('keeps stale mappings removable when the synced group is no longer listed', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg_stale', role: 'editor' }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByText('dg_stale')).toBeInTheDocument()
    const removeButton = screen.getByRole('button', { name: /Remove mapping for dg_stale/i })
    fireEvent.click(removeButton)

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/scim/group-role-mappings/m1', { method: 'DELETE' })
    })
    confirmSpy.mockRestore()
  })

  it('creates a mapping via the group picker', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [
        { id: 'g1', providerGroupId: 'dg1', name: 'Engineering' },
        { id: 'g2', providerGroupId: 'dg2', name: 'Sales' },
      ],
      mappings: [],
    })
    render(<ScimDirectorySettingsPanel />)
    await screen.findByText(/Group → role mappings/i)

    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'dg2' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: /Add mapping/i }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/org/scim/group-role-mappings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ providerGroupId: 'dg2', role: 'admin' }),
        }),
      )
    })
  })

  it('updates a mapping role inline via the per-row select', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }],
    })
    render(<ScimDirectorySettingsPanel />)
    const roleSelect = await screen.findByLabelText('Role for Engineering')
    fireEvent.change(roleSelect, { target: { value: 'admin' } })

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/org/scim/group-role-mappings/m1',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ role: 'admin' }) }),
      )
    })
  })

  it('optimistically reflects the new role on the controlled select before the refetch', async () => {
    // Hold the update POST open so the panel cannot have refetched yet — the
    // select must already show the new value purely from the optimistic write.
    let resolveUpdate: (value: unknown) => void = () => {}
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path === '/org/scim/directories' && method === 'GET') return [ROW_EXAMPLE]
      if (path === '/org/scim/group-role-mappings' && method === 'GET')
        return [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }]
      if (path === '/org/scim/groups' && method === 'GET')
        return [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }]
      if (path === '/org/scim/group-role-mappings/m1' && method === 'POST')
        return new Promise((resolve) => {
          resolveUpdate = resolve
        })
      return []
    })
    render(<ScimDirectorySettingsPanel />)
    const roleSelect = (await screen.findByLabelText('Role for Engineering')) as HTMLSelectElement
    fireEvent.change(roleSelect, { target: { value: 'admin' } })

    // POST still in flight (never resolved) — value reflects the optimistic write.
    await waitFor(() => {
      expect((screen.getByLabelText('Role for Engineering') as HTMLSelectElement).value).toBe('admin')
    })
    resolveUpdate({ id: 'm1' })
  })

  it('reverts the select to the previous role when the update POST fails', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path === '/org/scim/directories' && method === 'GET') return [ROW_EXAMPLE]
      if (path === '/org/scim/group-role-mappings' && method === 'GET')
        return [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }]
      if (path === '/org/scim/groups' && method === 'GET')
        return [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }]
      if (path === '/org/scim/group-role-mappings/m1' && method === 'POST')
        throw new Error('rate limited')
      return []
    })
    render(<ScimDirectorySettingsPanel />)
    const roleSelect = await screen.findByLabelText('Role for Engineering')
    fireEvent.change(roleSelect, { target: { value: 'admin' } })

    // After the rejection the optimistic write is rolled back to 'editor'.
    await waitFor(() => {
      expect((screen.getByLabelText('Role for Engineering') as HTMLSelectElement).value).toBe('editor')
    })
    // And an error toast surfaced the failure.
    await waitFor(() => {
      expect(useWorkflowStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true)
    })
  })

  it('removes a mapping after confirm', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<ScimDirectorySettingsPanel />)
    const removeButton = await screen.findByRole('button', { name: /Remove mapping for Engineering/i })
    fireEvent.click(removeButton)

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/scim/group-role-mappings/m1', { method: 'DELETE' })
    })
    confirmSpy.mockRestore()
  })

  it('shows the Re-sync now button when at least one mapping exists', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }],
    })
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByRole('button', { name: /Re-sync every active member/i })).toBeInTheDocument()
  })

  it('hides the Re-sync now button when there are no mappings', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [],
    })
    render(<ScimDirectorySettingsPanel />)
    await screen.findByText(/Group → role mappings/i)
    expect(screen.queryByRole('button', { name: /Re-sync every active member/i })).not.toBeInTheDocument()
  })

  it('re-syncs roles via POST /org/scim/resync', async () => {
    mockApi({
      directories: [ROW_EXAMPLE],
      groups: [{ id: 'g1', providerGroupId: 'dg1', name: 'Engineering' }],
      mappings: [{ id: 'm1', scimDirectoryId: 'sd-1', providerGroupId: 'dg1', role: 'editor' }],
    })
    render(<ScimDirectorySettingsPanel />)
    const button = await screen.findByRole('button', { name: /Re-sync every active member/i })
    fireEvent.click(button)
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/scim/resync', expect.objectContaining({ method: 'POST' }))
    })
  })
})
