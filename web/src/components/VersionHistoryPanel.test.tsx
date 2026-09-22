import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { ConfirmProvider } from './ConfirmDialog'
import { PLATFORM_TAG, invalidateTags } from '../lib/query-cache'
import { VersionHistoryPanel } from './VersionHistoryPanel'

vi.mock('../api', () => {
  const module = ({
  api: vi.fn(),
})
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

const initialState = useWorkflowStore.getState()

function makeWorkflow(url: string): WorkflowDefinition {
  return {
    id: 'wf_compare',
    name: 'Compare workflow',
    nodes: [{ id: 'fetch', type: 'http', config: { url } }],
    edges: [],
  }
}

function mockVersionHistoryApi(
  versionsByWorkflow: Record<string, Array<{ id: string; version: number; workflowId: string; createdAt: null; dagJson: WorkflowDefinition }>>,
) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith('/workflows/versions')) {
      const url = new URL(path, 'http://localhost')
      return versionsByWorkflow[url.searchParams.get('workflowId') ?? ''] ?? []
    }
    throw new Error(`Unexpected API call: ${path}`)
  })
}

function setPermissions(permissions: string[], role = 'editor', roleBase: 'viewer' | 'editor' | 'admin' = 'editor') {
  useWorkflowStore.setState({
    identityContext: {
      identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' },
      profile: { name: null, email: null },
      organizations: [{
        id: 'default', name: 'Default', plan: null, role, roleBase, permissions,
        usable: true, developmentFallback: false, isOwner: false,
      }],
      invitations: [],
      currentOrganizationId: 'default',
      selectionRequired: false,
      needsOrganization: false,
      truncated: false,
      invitationsTruncated: false,
    },
  })
}

describe('<VersionHistoryPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState(
      {
        ...initialState,
        session: null,
        userId: 'dev-user',
        orgId: 'default',
        currentWorkflowId: 'wf_compare',
        currentWorkflowName: 'Compare workflow',
        currentWorkflowSaved: true,
        toasts: [],
      },
      true,
    )
    setPermissions(['workflows.read', 'workflows.write', 'ai.write'])
  })

  it.each(['workflow', 'organization', 'user', 'refresh'] as const)('discards an older page after %s changes', async change => {
    let finish: (value: unknown) => void = () => { throw new Error('not requested') }
    const pending = new Promise(resolve => { finish = resolve })
    const first = Array.from({ length: 50 }, (_, index) => ({
      workflowId: 'wf_compare', createdAt: null, id: `version_${60 - index}`, version: 60 - index,
      dagJson: makeWorkflow(`https://initial.test/${index}`),
    }))
    let switched = false
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes('beforeVersion=')) return pending
      const workflowId = new URL(path, 'http://localhost').searchParams.get('workflowId')!
      return switched ? [{ ...first[0], workflowId, id: 'new-version', version: 80, dagJson: { ...makeWorkflow('https://new.test'), id: workflowId } }] : first
    })
    render(<VersionHistoryPanel />)
    await screen.findByText('v60')
    fireEvent.click(screen.getByTestId('version-history-load-more'))
    switched = true
    act(() => {
      if (change === 'refresh') invalidateTags([PLATFORM_TAG])
      else useWorkflowStore.setState(change === 'workflow' ? { currentWorkflowId: 'wf_next' }
        : change === 'organization' ? { orgId: 'next-org' } : { userId: 'next-user' })
    })
    if (change === 'workflow' || change === 'refresh') await screen.findByText('v80')
    await act(async () => finish([{ ...first[0], id: 'late-version', version: 10 }]))
    expect(screen.queryByText('v10')).not.toBeInTheDocument()
    expect(await screen.findByText('v80')).toBeInTheDocument()
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it.each(['workflow', 'organization', 'user', 'refresh', 'unmount', 'edit', 'permissions'] as const)('does not hydrate an old confirmation after %s changes', async change => {
    mockVersionHistoryApi({ wf_compare: [{ workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://old.test') }] })
    useWorkflowStore.setState({ workflowDirty: true })
    const view = render(<ConfirmProvider><VersionHistoryPanel /></ConfirmProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /v1/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    if (change === 'unmount') view.rerender(<ConfirmProvider><div>Elsewhere</div></ConfirmProvider>)
    else act(() => {
      if (change === 'refresh') invalidateTags([PLATFORM_TAG])
      else if (change === 'permissions') setPermissions(['workflows.read'])
      else if (change === 'edit') useWorkflowStore.getState().setWorkflowName('New edits')
      else useWorkflowStore.setState(change === 'workflow' ? { currentWorkflowId: 'wf_next' }
        : change === 'organization' ? { orgId: 'next-org' } : { userId: 'next-user' })
    })
    const revision = useWorkflowStore.getState().workflowRevision
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /Discard/i }))
    await act(async () => {})
    expect(useWorkflowStore.getState().workflowRevision).toBe(revision)
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it.each(['success', 'failure'] as const)('ignores an older suggestion %s after a newer comparison starts', async outcome => {
    let finish: (value: unknown) => void = () => { throw new Error('not requested') }
    let fail: (reason: Error) => void = () => { throw new Error('not requested') }
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    let posts = 0
    vi.mocked(api).mockImplementation(async path => {
      if (path.startsWith('/workflows/versions')) return [3, 2, 1].map(version => ({ workflowId: 'wf_compare', createdAt: null, id: `version_${version}`, version, dagJson: makeWorkflow(`https://v${version}.test`) }))
      return ++posts === 1 ? pending : { mode: 'fallback', aiError: 'NEW comparison' }
    })
    render(<VersionHistoryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /^Compare$/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))
    fireEvent.click(screen.getByRole('button', { name: /Suggest improvement/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v3/i }))
    fireEvent.click(screen.getByRole('button', { name: /Suggest improvement/i }))
    await screen.findByText('NEW comparison')
    await act(async () => {
      if (outcome === 'failure') fail(new Error('OLD comparison'))
      else finish({ mode: 'fallback', aiError: 'OLD comparison' })
    })
    expect(screen.getByText('NEW comparison')).toBeInTheDocument()
    expect(screen.queryByText('OLD comparison')).not.toBeInTheDocument()
  })

  it('pins the immutable version when hydrating the history canvas', async () => {
    mockVersionHistoryApi({ wf_compare: [{ workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://old.test') }] })
    render(<VersionHistoryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /v1/i }))
    expect(useWorkflowStore.getState().currentWorkflowVersion).toEqual({ id: 'version_1', version: 1 })
  })

  it('distinguishes initial loading and failed reads from empty history and retries freshly', async () => {
    let reject: (reason: Error) => void = () => { throw new Error('not requested') }
    vi.mocked(api).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const view = render(<VersionHistoryPanel />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.queryByTestId('version-history-empty')).not.toBeInTheDocument()
    const firstSignal = vi.mocked(api).mock.calls[0][1]?.signal
    await act(async () => reject(new Error('offline')))
    expect(screen.getByRole('alert')).toHaveTextContent('Version history failed to load')
    expect(screen.queryByTestId('version-history-empty')).not.toBeInTheDocument()
    vi.mocked(api).mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('version-history-empty')
    expect(firstSignal?.aborted).toBe(true)
    const nextSignal = vi.mocked(api).mock.calls.at(-1)?.[1]?.signal
    expect(nextSignal).toBeInstanceOf(AbortSignal)
    expect(nextSignal).not.toBe(firstSignal)
    view.unmount()
    expect(nextSignal?.aborted).toBe(true)
  })

  it('aborts pagination and suppresses its late error after unmount', async () => {
    let reject: (reason: Error) => void = () => { throw new Error('not requested') }
    const first = Array.from({ length: 50 }, (_, index) => ({ workflowId: 'wf_compare', createdAt: null, id: `v${60 - index}`, version: 60 - index, dagJson: makeWorkflow('https://test.local') }))
    vi.mocked(api).mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const view = render(<VersionHistoryPanel />)
    await screen.findByText('v60')
    fireEvent.click(screen.getByTestId('version-history-load-more'))
    const signal = vi.mocked(api).mock.calls.at(-1)?.[1]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => reject(new Error('late offline')))
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('renders a structural diff after selecting two versions in compare mode', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
      ],
    })

    render(<VersionHistoryPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    expect(screen.getByLabelText('Structural workflow diff')).toBeInTheDocument()
    expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/v2/).length).toBeGreaterThan(0)
    expect(screen.getByText(/1 node.*changed/i)).toBeInTheDocument()
  })

  it('loads older versions below the oldest row shown', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        workflowId: 'wf_compare', createdAt: null, id: `v${from - index}`, version: from - index, dagJson: makeWorkflow(`https://example.test/${from - index}`),
      }))
    vi.mocked(api).mockImplementation(async (path) => {
      const url = new URL(path, 'http://localhost')
      if (!url.pathname.startsWith('/workflows/versions')) throw new Error(`Unexpected API call: ${path}`)
      const before = url.searchParams.get('beforeVersion')
      return before ? page(Number(before) - 1, 3) : page(60, 50)
    })
    setPermissions(['workflows.read', 'workflows.write', 'ai.write'])
    render(<VersionHistoryPanel />)
    // Text queries: role queries over 50 rows exceed the default wait.
    await screen.findByText('v60')
    expect(screen.queryByText('v10')).toBeNull()

    fireEvent.click(screen.getByTestId('version-history-load-more'))
    await screen.findByText('v8')
    expect(vi.mocked(api)).toHaveBeenLastCalledWith(expect.stringContaining('beforeVersion=11'), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    // A short page means the history is exhausted.
    expect(screen.queryByTestId('version-history-load-more')).toBeNull()
  })

  it('does not hydrate or enable comparison from a malformed version page', async () => {
    vi.mocked(api).mockResolvedValue([{ workflowId: 'other', createdAt: null, id: 'foreign', version: 2, dagJson: makeWorkflow('https://foreign.test') }])
    render(<VersionHistoryPanel />)
    await waitFor(() => expect(useWorkflowStore.getState().toasts).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /v2/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Compare/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Roll back to/i })).toBeNull()
  })

  it('retains loaded versions and the cursor after rejecting an invalid older page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({ workflowId: 'wf_compare', createdAt: null, id: `v${60 - i}`, version: 60 - i, dagJson: makeWorkflow('https://example.test') }))
    vi.mocked(api).mockResolvedValueOnce(firstPage).mockResolvedValueOnce([
      { ...firstPage[0], id: 'bad-cursor', version: 11 },
    ]).mockResolvedValueOnce([{ ...firstPage[0], id: 'v10', version: 10 }])
    render(<VersionHistoryPanel />)
    await screen.findByText('v60')
    fireEvent.click(screen.getByTestId('version-history-load-more'))
    await waitFor(() => expect(useWorkflowStore.getState().toasts).toHaveLength(1))
    expect(screen.getByText('v60')).toBeInTheDocument()
    expect(screen.getByText('v11')).toBeInTheDocument()
    expect(screen.queryByText('v10')).toBeNull()
    const retry = screen.getByTestId('version-history-load-more')
    await waitFor(() => expect(retry).toBeEnabled())
    fireEvent.click(retry)
    await screen.findByText('v10')
    expect(vi.mocked(api)).toHaveBeenLastCalledWith(expect.stringContaining('beforeVersion=11'), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.queryByTestId('version-history-load-more')).toBeNull()
  })

  it('does not request version history for an unsaved workflow draft', async () => {
    vi.mocked(api).mockResolvedValue([])
    useWorkflowStore.setState({
      currentWorkflowId: 'ui-test',
      currentWorkflowSaved: false,
    }, false)

    render(<VersionHistoryPanel />)

    await screen.findByTestId('version-history-empty')
    expect(vi.mocked(api).mock.calls.some(([path]) =>
      typeof path === 'string' && path.startsWith('/workflows/versions'),
    )).toBe(false)
  })

  it('hides the Rollback button when only one version exists', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v1/i })

    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it('shows the Rollback button on older versions but not the latest', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v3/i })

    expect(screen.queryByRole('button', { name: /Roll back to v3/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Roll back to v2/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('hides Rollback buttons for viewers', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })
    setPermissions(['workflows.read'], 'viewer', 'viewer')

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
    })
  })

  it('does not infer write access from an admin-rank custom role', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })
    setPermissions(['workflows.read'], 'billing-admin', 'admin')

    render(<VersionHistoryPanel />)

    await screen.findByRole('button', { name: /v2/i })
    expect(screen.queryByRole('button', { name: /Roll back to v1/i })).not.toBeInTheDocument()
  })

  it('honors an explicit write grant on a viewer-rank custom role', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })
    setPermissions(['workflows.read', 'workflows.write'], 'workflow-operator', 'viewer')

    render(<VersionHistoryPanel />)

    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('hides Rollback buttons in compare mode (the row checkbox owns the click)', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it.each(['refresh', 'workflow', 'organization', 'user', 'permissions'] as const)('owns the exact rollback preview until %s changes', async change => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(await screen.findByRole('button', { name: /Roll back to v1/i }))

    expect(screen.getByRole('heading', { name: /Roll back to v1/i })).toBeInTheDocument()
    expect(screen.getByText(/v2 \(current\)/i)).toBeInTheDocument()
    expect(screen.getByText(/v1 \(rolling back to\)/i)).toBeInTheDocument()
    act(() => {
      if (change === 'refresh') invalidateTags([PLATFORM_TAG])
      else if (change === 'permissions') setPermissions(['workflows.read'])
      else useWorkflowStore.setState(change === 'workflow' ? { currentWorkflowId: 'wf_next' }
        : change === 'organization' ? { orgId: 'next-org' } : { userId: 'next-user' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })

  it('exposes the Suggest improvement button only in compare mode with two versions selected and editor role', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    // No button before Compare is toggled.
    expect(screen.queryByRole('button', { name: /Suggest improvement/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))

    // No button while only one version is picked.
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    expect(screen.queryByRole('button', { name: /Suggest improvement/i })).not.toBeInTheDocument()

    // Both picked → button visible.
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))
    expect(await screen.findByRole('button', { name: /Suggest improvement/i })).toBeInTheDocument()
  })

  it('hides the Suggest improvement button for viewers', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })
    setPermissions(['workflows.read'], 'viewer', 'viewer')

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Suggest improvement/i })).not.toBeInTheDocument()
    })
  })

  it('renders the AI-suggestion diff with rationale + chip strip on success', async () => {
    const baseFlow = makeWorkflow('https://api.b')
    const improvedFlow: WorkflowDefinition = {
      ...baseFlow,
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.b', retry: { maxAttempts: 3 } } }],
      edges: [],
    }
    const simplifiedFlow: WorkflowDefinition = {
      ...baseFlow,
      // Add a downstream noop so the diff renderer reports a structural
      // change vs the base — otherwise the rationale block is omitted
      // by the empty-state branch in WorkflowDiffView.
      nodes: [
        ...baseFlow.nodes,
        { id: 'noop', type: 'noop', config: {} },
      ],
      edges: [{ from: 'fetch', to: 'noop' }],
    }
    const aiResponse = {
      mode: 'ai' as const,
      suggestions: [
        { workflow: improvedFlow, rationale: 'Add retry to handle transient failures.', approachLabel: 'add_retry', confidence: 0.8 },
        { workflow: simplifiedFlow, rationale: 'Or simplify by removing the unused parameter.', approachLabel: 'simplify', confidence: 0.5 },
      ],
      model: 'claude-haiku-4-5-20251001',
    }
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/workflows/versions')) {
        return [
          { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') return aiResponse
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    fireEvent.click(await screen.findByRole('button', { name: /Suggest improvement/i }))

    // Result panel mounts with rationale and chip strip.
    await screen.findByLabelText('AI suggested improvement')
    expect(screen.getByText(/Add retry to handle transient failures/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add retry · 80%/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Simplify · 50%/i })).toBeInTheDocument()

    // Switching to the second chip swaps the rendered rationale.
    fireEvent.click(screen.getByRole('button', { name: /Simplify · 50%/i }))
    expect(screen.getByText(/Or simplify by removing the unused parameter/i)).toBeInTheDocument()
  })

  it('renders a fallback ribbon when AI suggest returns mode: fallback', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/workflows/versions')) {
        return [
          { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') {
        return {
          mode: 'fallback',
          aiError: 'no_llm_configured',
          suggestions: [{
            workflow: makeWorkflow('https://api.b'),
            rationale: 'AI is unavailable',
            approachLabel: 'other',
            confidence: 0,
          }],
        }
      }
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    fireEvent.click(await screen.findByRole('button', { name: /Suggest improvement/i }))

    expect(await screen.findByText(/AI improvement unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/no_llm_configured/i)).toBeInTheDocument()
    // Fallback ribbon shows but no AI-result diff.
    expect(screen.queryByLabelText('AI suggested improvement')).not.toBeInTheDocument()
  })

  it('renders a fallback ribbon when the API request itself throws', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/workflows/versions')) {
        return [
          { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') {
        throw new Error('upstream rate limit')
      }
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    fireEvent.click(await screen.findByRole('button', { name: /Suggest improvement/i }))

    expect(await screen.findByText(/upstream rate limit/i)).toBeInTheDocument()
    expect(screen.getByText(/AI improvement unavailable/i)).toBeInTheDocument()
  })

  it('clears AI suggestion state when the version pair changes', async () => {
    const baseFlow = makeWorkflow('https://api.b')
    const improvedFlow: WorkflowDefinition = {
      ...baseFlow,
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.b', retry: { maxAttempts: 3 } } }],
      edges: [],
    }
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/workflows/versions')) {
        return [
          { workflowId: 'wf_compare', createdAt: null, id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') {
        return {
          mode: 'ai',
          suggestions: [{ workflow: improvedFlow, rationale: 'r', approachLabel: 'add_retry', confidence: 0.7 }],
        }
      }
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v3/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    fireEvent.click(await screen.findByRole('button', { name: /Suggest improvement/i }))
    await screen.findByLabelText('AI suggested improvement')

    // Picking a different version unselects v2; the suggestion should drop.
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v3/i }))

    await waitFor(() => {
      expect(screen.queryByLabelText('AI suggested improvement')).not.toBeInTheDocument()
    })
  })

  it('drops a stale AI suggestion that resolves AFTER the operator changes the version pair', async () => {
    const baseFlow = makeWorkflow('https://api.b')
    const improvedFlow: WorkflowDefinition = {
      ...baseFlow,
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.b', retry: { maxAttempts: 3 } } }],
      edges: [],
    }
    // Hold the AI response open until we trigger it.
    let resolveAi: ((value: unknown) => void) | null = null
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/workflows/versions')) {
        return [
          { workflowId: 'wf_compare', createdAt: null, id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { workflowId: 'wf_compare', createdAt: null, id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') {
        return new Promise<unknown>((resolve) => {
          resolveAi = resolve
        })
      }
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v3/i })

    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    // Click — request is now in flight.
    fireEvent.click(await screen.findByRole('button', { name: /Suggest improvement/i }))

    // While the request is pending, change the version pair.
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v3/i }))

    // Now resolve the stale AI response.
    await act(async () => {
      resolveAi?.({
        mode: 'ai',
        suggestions: [{ workflow: improvedFlow, rationale: 'STALE', approachLabel: 'add_retry', confidence: 0.8 }],
      })
    })

    // The stale suggestion must NOT mount — the cancel-ref guard
    // bails out of setState after the await.
    await waitFor(() => {
      expect(screen.queryByLabelText('AI suggested improvement')).not.toBeInTheDocument()
    })
    expect(screen.queryByText(/STALE/i)).not.toBeInTheDocument()
  })

  it('clears compare state when the active workflow changes', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { workflowId: 'wf_compare', createdAt: null, id: 'old_1', version: 7, dagJson: makeWorkflow('https://old.a') },
        { workflowId: 'wf_compare', createdAt: null, id: 'old_2', version: 8, dagJson: makeWorkflow('https://old.b') },
      ],
      wf_new: [
        { workflowId: 'wf_new', createdAt: null, id: 'new_1', version: 1, dagJson: { ...makeWorkflow('https://new.a'), id: 'wf_new' } },
      ],
    })

    render(<VersionHistoryPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v7/i }))
    fireEvent.click(screen.getByRole('button', { name: /v8/i }))
    expect(screen.getByLabelText('Structural workflow diff')).toBeInTheDocument()

    await act(async () => {
      useWorkflowStore.setState({ currentWorkflowId: 'wf_new' })
    })

    await waitFor(() => {
      expect(screen.queryByLabelText('Structural workflow diff')).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('button', { name: /v1/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /v7/i })).not.toBeInTheDocument()
  })
})
