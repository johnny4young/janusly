import { StrictMode } from 'react'
import { useInvalidationNonce } from '../lib/query-cache'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
})

const REFRESH_TAGS = ['platform'] as const
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
    // Cancel any pending bumpPlatformVersion timer left by a prior
    // test so the 100ms debounce can't bleed across cases.
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'wf_rollback', toasts: [], identityContext: {
      identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' },
      profile: { name: null, email: null },
      organizations: [{ id: 'default', name: 'Default', plan: null, role: 'editor', roleBase: 'editor',
        permissions: ['workflows.read', 'workflows.write'], usable: true, developmentFallback: false, isOwner: false }],
      invitations: [], currentOrganizationId: 'default', selectionRequired: false, needsOrganization: false,
      truncated: false, invitationsTruncated: false,
    } }, true)
  })

  it('renders the diff (current → target) and the Roll back primary button at idle', () => {
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Roll back to v3/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Structural workflow diff')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Roll back$/i })).toBeInTheDocument()
    expect(screen.getByText(/v5 \(current\)/i)).toBeInTheDocument()
    expect(screen.getByText(/v3 \(rolling back to\)/i)).toBeInTheDocument()
  })

  it('posts to /workflows/rollback, hydrates the canvas, invalidates dependent resources, and toasts on success', async () => {
    const { result: refresh } = renderHook(() => useInvalidationNonce(REFRESH_TAGS))
    vi.mocked(api).mockResolvedValueOnce({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 })
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    expect(vi.mocked(api)).toHaveBeenCalledWith('/workflows/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ workflowId: 'wf_rollback', sourceVersionId: 'version_3' }),
    }))

    // bumpPlatformVersion is debounced (100ms trailing edge) — assert
    // via waitFor so the timer fires under real wallclock during the
    // poll window.
    await waitFor(() => expect(refresh.current).toBe(1))
    const state = useWorkflowStore.getState()
    expect(state.toasts.some((toast) => /Rolled back to v3 as v6/i.test(toast.message) && toast.tone === 'success')).toBe(true)
    // hydrateWorkflow swaps currentWorkflowId to the rolled-back DAG's id
    expect(state.currentWorkflowId).toBe('wf_rollback')
    expect(state.currentWorkflowVersion).toEqual({ id: 'v6', version: 6 })
  })

  it('shows an inline error and no canvas hydrate when the rollback request fails (e.g. 403/404)', async () => {
    const { result: refresh } = renderHook(() => useInvalidationNonce(REFRESH_TAGS))
    vi.mocked(api).mockRejectedValueOnce(new Error('Forbidden'))
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Forbidden/i)
    })
    expect(refresh.current).toBe(0)
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
  it.each(['organization', 'user', 'workflow', 'edit', 'permissions', 'props', 'unmount'] as const)('discards a completed rollback after %s changes', async change => {
    let finish: (value: unknown) => void = () => { throw new Error('not started') }
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const onClose = vi.fn()
    const view = render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    const signal = vi.mocked(api).mock.calls[0][1]?.signal
    if (change === 'unmount') view.unmount()
    else if (change === 'props') view.rerender(<RollbackConfirmDialog workflowId="wf_other" current={current} target={target} onClose={onClose} />)
    else act(() => {
      if (change === 'edit') useWorkflowStore.getState().setWorkflowName('New edits')
      else if (change === 'permissions') useWorkflowStore.setState({ identityContext: null })
      else useWorkflowStore.setState(change === 'organization' ? { orgId: 'other' }
        : change === 'user' ? { userId: 'other' } : { currentWorkflowId: 'other' })
    })
    const revision = useWorkflowStore.getState().workflowRevision
    await act(async () => finish({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 }))
    expect(useWorkflowStore.getState().workflowRevision).toBe(revision)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
  })

  it.each([
    null, {}, { workflowId: 'other' }, { sourceVersion: 2 }, { versionId: '' },
    { versionId: 'version_3' }, { versionId: 'version_5' }, { version: 5 }, { version: 6.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed or foreign rollback success %j', async patch => {
    vi.mocked(api).mockResolvedValueOnce(patch === null || Object.keys(patch).length === 0 ? patch
      : { workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3, ...patch })
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    const revision = useWorkflowStore.getState().workflowRevision
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    await screen.findByRole('alert')
    expect(useWorkflowStore.getState().workflowRevision).toBe(revision)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it.each([{ versionId: ' x ' }, { versionId: 'x'.repeat(257) }])('leaves version id format to the server %j', async patch => {
    vi.mocked(api).mockResolvedValueOnce({ workflowId: 'wf_rollback', version: 6, sourceVersion: 3, ...patch })
    const onClose = vi.fn()
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('does not offer rollback without a write grant', () => {
    useWorkflowStore.setState({ identityContext: null })
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Roll back$/i })).not.toBeInTheDocument()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('warns about unsaved edits and focuses Cancel rather than rollback', () => {
    useWorkflowStore.setState({ workflowDirty: true })
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    expect(screen.getByText(/Replacing it discards them/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('dispatches only once even before React renders the busy state', async () => {
    vi.mocked(api).mockImplementation(() => new Promise(() => {}))
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    const action = screen.getByRole('button', { name: /^Roll back$/i })
    act(() => { action.click(); action.click() })
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
  })

  it('keeps its reviewed target immutable while the caller changes its object', async () => {
    const mutable = structuredClone(target)
    let finish: (value: unknown) => void = () => { throw new Error('not started') }
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={mutable} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    mutable.dagJson.name = 'Unreviewed mutation'
    await act(async () => finish({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 }))
    expect(useWorkflowStore.getState().currentWorkflowName).toBe('Rollback workflow')
  })

  it('suppresses a late rejection after a new operator arrives', async () => {
    let fail: (reason: Error) => void = () => { throw new Error('not started') }
    vi.mocked(api).mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    act(() => useWorkflowStore.setState({ userId: 'other' }))
    await act(async () => fail(new Error('old operator error')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('rejects stale intent even before the subscriber render', () => {
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    const action = screen.getByRole('button', { name: /^Roll back$/i })
    act(() => { useWorkflowStore.setState({ orgId: 'other' }); action.click() })
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('retains a live request owner after Strict Mode effect replay', async () => {
    vi.mocked(api).mockResolvedValueOnce({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 })
    render(<StrictMode><RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    await waitFor(() => expect(useWorkflowStore.getState().currentWorkflowVersion).toEqual({ id: 'v6', version: 6 }))
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
  })

  it('does not revive an old request when the operator changes away and back in one update', async () => {
    let finish: (value: unknown) => void = () => { throw new Error('not started') }
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<RollbackConfirmDialog workflowId="wf_rollback" current={current} target={target} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Roll back$/i }))
    const original = useWorkflowStore.getState().userId
    const revision = useWorkflowStore.getState().workflowRevision
    act(() => { useWorkflowStore.setState({ userId: 'other' }); useWorkflowStore.setState({ userId: original }) })
    await act(async () => finish({ workflowId: 'wf_rollback', versionId: 'v6', version: 6, sourceVersion: 3 }))
    expect(useWorkflowStore.getState().workflowRevision).toBe(revision)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

})
