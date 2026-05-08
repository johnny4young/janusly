import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { VersionHistoryPanel } from './VersionHistoryPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

function makeWorkflow(url: string): WorkflowDefinition {
  return {
    id: 'wf_compare',
    name: 'Compare workflow',
    nodes: [{ id: 'fetch', type: 'http', config: { url } }],
    edges: [],
  }
}

const editorMember = { id: 'member-1', orgId: 'default', userId: 'dev-user', role: 'editor' as const }

function mockVersionHistoryApi(
  versionsByWorkflow: Record<string, Array<{ id: string; version: number; dagJson: WorkflowDefinition }>>,
  members = [editorMember],
) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/members') return members
    if (path.startsWith('/workflows/versions')) {
      const url = new URL(path, 'http://localhost')
      return versionsByWorkflow[url.searchParams.get('workflowId') ?? ''] ?? []
    }
    throw new Error(`Unexpected API call: ${path}`)
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
        toasts: [],
        platformVersion: 0,
      },
      true,
    )
  })

  it('renders a structural diff after selecting two versions in compare mode', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
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

  it('hides the Rollback button when only one version exists', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v1/i })

    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it('shows the Rollback button on older versions but not the latest', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v3/i })

    expect(screen.queryByRole('button', { name: /Roll back to v3/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Roll back to v2/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('hides Rollback buttons for viewers', async () => {
    mockVersionHistoryApi(
      {
        wf_compare: [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ],
      },
      [{ ...editorMember, role: 'viewer' }],
    )

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
    })
  })

  it('uses the dev-headers admin fallback when userId is null (no Supabase session yet)', async () => {
    // Dev-mode auth flow leaves userId=null in the store (App.tsx
    // clears auth on every onAuthStateChange when session is null),
    // so loadEffectiveRole's no-userId path must mirror the
    // backend's "no org_members row → admin" behaviour. Otherwise
    // role-gated UI is silently hidden in dev.
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })
    useWorkflowStore.setState({ userId: null }, false)

    render(<VersionHistoryPanel />)

    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('uses the dev-headers admin fallback when no member row exists', async () => {
    mockVersionHistoryApi(
      {
        wf_compare: [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ],
      },
      [],
    )

    render(<VersionHistoryPanel />)

    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
  })

  it('hides Rollback buttons in compare mode (the row checkbox owns the click)', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    expect(await screen.findByRole('button', { name: /Roll back to v1/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Compare/i }))
    expect(screen.queryByRole('button', { name: /Roll back to/i })).not.toBeInTheDocument()
  })

  it('opens the Rollback dialog with current and target labels when Rollback is clicked', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      ],
    })

    render(<VersionHistoryPanel />)
    await screen.findByRole('button', { name: /v2/i })

    fireEvent.click(await screen.findByRole('button', { name: /Roll back to v1/i }))

    expect(screen.getByRole('heading', { name: /Roll back to v1/i })).toBeInTheDocument()
    expect(screen.getByText(/v2 \(current\)/i)).toBeInTheDocument()
    expect(screen.getByText(/v1 \(rolling back to\)/i)).toBeInTheDocument()
  })

  it('exposes the Suggest improvement button only in compare mode with two versions selected and editor role', async () => {
    mockVersionHistoryApi({
      wf_compare: [
        { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
        { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
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
    mockVersionHistoryApi(
      {
        wf_compare: [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ],
      },
      [{ ...editorMember, role: 'viewer' }],
    )

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
        { workflow: improvedFlow, rationale: 'Add retry to handle transient failures.', approachLabel: 'add_retry', confidence: 80 },
        { workflow: simplifiedFlow, rationale: 'Or simplify by removing the unused parameter.', approachLabel: 'simplify', confidence: 50 },
      ],
      model: 'claude-haiku-4-5-20251001',
    }
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/members') return [editorMember]
      if (path.startsWith('/workflows/versions')) {
        return [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
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
    expect(screen.getByRole('tab', { name: /Add retry · 80%/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Simplify · 50%/i })).toBeInTheDocument()

    // Switching to the second chip swaps the rendered rationale.
    fireEvent.click(screen.getByRole('tab', { name: /Simplify · 50%/i }))
    expect(screen.getByText(/Or simplify by removing the unused parameter/i)).toBeInTheDocument()
  })

  it('renders a fallback ribbon when AI suggest returns mode: fallback', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/members') return [editorMember]
      if (path.startsWith('/workflows/versions')) {
        return [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
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
      if (path === '/members') return [editorMember]
      if (path.startsWith('/workflows/versions')) {
        return [
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
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
      if (path === '/members') return [editorMember]
      if (path.startsWith('/workflows/versions')) {
        return [
          { id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
        ]
      }
      if (path === '/ai/suggest-improvement') {
        return {
          mode: 'ai',
          suggestions: [{ workflow: improvedFlow, rationale: 'r', approachLabel: 'add_retry', confidence: 70 }],
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
      if (path === '/members') return [editorMember]
      if (path.startsWith('/workflows/versions')) {
        return [
          { id: 'version_3', version: 3, dagJson: makeWorkflow('https://api.c') },
          { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
          { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
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
        suggestions: [{ workflow: improvedFlow, rationale: 'STALE', approachLabel: 'add_retry', confidence: 80 }],
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
        { id: 'old_1', version: 7, dagJson: makeWorkflow('https://old.a') },
        { id: 'old_2', version: 8, dagJson: makeWorkflow('https://old.b') },
      ],
      wf_new: [
        { id: 'new_1', version: 1, dagJson: makeWorkflow('https://new.a') },
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
