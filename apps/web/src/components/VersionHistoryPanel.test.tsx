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

describe('<VersionHistoryPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState(
      {
        ...initialState,
        currentWorkflowId: 'wf_compare',
        currentWorkflowName: 'Compare workflow',
        toasts: [],
        platformVersion: 0,
      },
      true,
    )
  })

  it('renders a structural diff after selecting two versions in compare mode', async () => {
    vi.mocked(api).mockResolvedValueOnce([
      { id: 'version_1', version: 1, dagJson: makeWorkflow('https://api.a') },
      { id: 'version_2', version: 2, dagJson: makeWorkflow('https://api.b') },
    ])

    render(<VersionHistoryPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Compare/i }))
    fireEvent.click(screen.getByRole('button', { name: /v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /v1/i }))

    expect(screen.getByLabelText('Structural workflow diff')).toBeInTheDocument()
    expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/v2/).length).toBeGreaterThan(0)
    expect(screen.getByText(/1 node.*changed/i)).toBeInTheDocument()
  })

  it('clears compare state when the active workflow changes', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce([
        { id: 'old_1', version: 7, dagJson: makeWorkflow('https://old.a') },
        { id: 'old_2', version: 8, dagJson: makeWorkflow('https://old.b') },
      ])
      .mockResolvedValueOnce([
        { id: 'new_1', version: 1, dagJson: makeWorkflow('https://new.a') },
      ])

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
