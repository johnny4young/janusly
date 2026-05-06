import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

function makeWorkflow(url: string): WorkflowDefinition {
  return {
    id: 'wf_rollback',
    name: 'Rollback workflow',
    nodes: [{ id: 'fetch', type: 'http', config: { url } }],
    edges: [],
  }
}

const current = {
  id: 'version_5',
  version: 5,
  dagJson: makeWorkflow('https://api.broken'),
}

const target = {
  id: 'version_3',
  version: 3,
  dagJson: makeWorkflow('https://api.good'),
}

describe('<RollbackConfirmDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, toasts: [], platformVersion: 0 }, true)
  })

  it('renders the diff (current → target) and the Roll back primary button at idle', () => {
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Roll back to v3/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Structural workflow diff')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Roll back$/i })).toBeInTheDocument()
    expect(screen.getByText(/v5 \(current\)/i)).toBeInTheDocument()
    expect(screen.getByText(/v3 \(rolling back to\)/i)).toBeInTheDocument()
  })

  it('posts to /workflows/rollback, hydrates the canvas, bumps platform version, and toasts on success', async () => {
    vi.mocked(api).mockResolvedValueOnce({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 })
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)

    const platformVersionBefore = useWorkflowStore.getState().platformVersion

    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))

    await waitFor(() => {
      expect(screen.getByText(/Rolled back to v3 as v6/i)).toBeInTheDocument()
    })

    expect(vi.mocked(api)).toHaveBeenCalledWith('/workflows/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ workflowId: 'wf_rollback', sourceVersionId: 'version_3' }),
    }))

    const state = useWorkflowStore.getState()
    expect(state.platformVersion).toBe(platformVersionBefore + 1)
    expect(state.toasts.some((toast) => /Rolled back to v3 as v6/i.test(toast.message) && toast.tone === 'success')).toBe(true)
    // hydrateWorkflow swaps currentWorkflowId to the rolled-back DAG's id
    expect(state.currentWorkflowId).toBe('wf_rollback')
  })

  it('shows an inline error and no canvas hydrate when the rollback request fails (e.g. 403/404)', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Forbidden'))
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)

    const platformVersionBefore = useWorkflowStore.getState().platformVersion

    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Forbidden/i)
    })
    expect(useWorkflowStore.getState().platformVersion).toBe(platformVersionBefore)
    expect(useWorkflowStore.getState().toasts).toEqual([])
    // No api retry-button mounted on error — operator re-picks from the panel
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument()
  })

  it('Cancel does not call the API and triggers onClose', () => {
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalled()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })
})
