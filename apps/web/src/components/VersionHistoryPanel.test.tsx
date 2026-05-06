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
