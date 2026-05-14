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

describe('<ScimDirectorySettingsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('renders the connect form when no directory exists', async () => {
    vi.mocked(api).mockResolvedValueOnce([])
    render(<ScimDirectorySettingsPanel />)
    expect(await screen.findByPlaceholderText(/directory_01…/)).toBeInTheDocument()
    expect(screen.getByText(/Connect directory/)).toBeInTheDocument()
  })

  it('renders the directory row when one is attached and hides the form', async () => {
    vi.mocked(api).mockResolvedValueOnce([ROW_EXAMPLE])
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
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/scim/directories' && (!init || init.method !== 'POST' && init.method !== 'DELETE')) {
        return []
      }
      if (path === '/org/scim/directories' && init?.method === 'POST') {
        return { id: 'sd-new' }
      }
      return []
    })

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
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/scim/directories' && (!init || init.method !== 'DELETE')) {
        return [ROW_EXAMPLE]
      }
      if (path.startsWith('/org/scim/directories/') && init?.method === 'DELETE') {
        return { ok: true }
      }
      return []
    })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<ScimDirectorySettingsPanel />)
    const button = await screen.findByRole('button', { name: /Disconnect/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/scim/directories/sd-1', { method: 'DELETE' })
    })
    confirmSpy.mockRestore()
  })
})
