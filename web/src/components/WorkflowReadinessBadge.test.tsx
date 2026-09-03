import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const noop = () => undefined

describe('<WorkflowReadinessBadge />', () => {
  beforeEach(() => {
    initI18n('en')
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({
      activeTab: 'home',
      selectedNodeId: null,
      selectedEdgeId: null,
      nodes: [],
      workflowRevision: 0,
    })
  })

  afterEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  it('shows an unavailable state when the readiness endpoint fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('service down'))

    render(<WorkflowReadinessBadge onOpenProblems={noop} />)

    await waitFor(() => {
      expect(screen.getByText('Readiness unavailable')).toBeInTheDocument()
    })
  })

  it('shows the green ready state when the endpoint returns pass', async () => {
    vi.mocked(api).mockResolvedValueOnce({ status: 'pass', issues: [] })

    render(<WorkflowReadinessBadge onOpenProblems={noop} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open authoring problems — Production · Ready' })).toBeInTheDocument()
    })
  })

  it('publishes results and coalesces rapid semantic revisions into one refetch', async () => {
    const onResult = vi.fn()
    vi.mocked(api).mockResolvedValue({ status: 'pass', issues: [] })
    render(<WorkflowReadinessBadge onOpenProblems={noop} onResult={onResult} />)
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'pass', issues: [] }))

    vi.mocked(api).mockClear()
    useWorkflowStore.setState({ workflowRevision: 1 })
    useWorkflowStore.setState({ workflowRevision: 2 })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(onResult).toHaveBeenCalledWith(null)
  })

  it('opens the canonical Problems surface without rendering a duplicate technical list', async () => {
    const onOpenProblems = vi.fn()
    vi.mocked(api).mockResolvedValueOnce({
      status: 'fail',
      issues: [{
        code: 'external_node_missing_retry',
        severity: 'fail',
        message: 'Missing retry policy',
        nodeId: 'request',
        suggestion: 'Set retry.maxAttempts.',
      }],
    })

    render(<WorkflowReadinessBadge onOpenProblems={onOpenProblems} />)

    const summary = await screen.findByRole('button', {
      name: 'Open authoring problems — Production · 1 blocker',
    })
    fireEvent.click(summary)

    expect(onOpenProblems).toHaveBeenCalledOnce()
    expect(screen.queryByText('external_node_missing_retry')).toBeNull()
    expect(screen.queryByText('Set retry.maxAttempts.')).toBeNull()
  })

  it('renders the scoped summary in Spanish', async () => {
    initI18n('es')
    vi.mocked(api).mockResolvedValueOnce({
      status: 'fail',
      issues: [{
        code: 'external_node_missing_retry',
        severity: 'fail',
        message: 'Missing retry policy',
        nodeId: 'request',
      }],
    })

    render(<WorkflowReadinessBadge onOpenProblems={noop} />)

    expect(await screen.findByRole('button', {
      name: 'Abrir problemas de autoría — Producción · 1 bloqueo',
    })).toBeInTheDocument()
  })
})
