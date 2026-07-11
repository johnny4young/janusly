import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge'
import { consumeResilienceFocus } from './resilience-focus-bus'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const initialNodes = useWorkflowStore.getState().nodes

describe('<WorkflowReadinessBadge />', () => {
  beforeEach(() => {
    initI18n('en')
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ activeTab: 'home', selectedNodeId: null, selectedEdgeId: null, nodes: initialNodes, workflowRevision: 0 })
  })

  afterEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  it('shows an unavailable state when the readiness endpoint fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('service down'))

    render(<WorkflowReadinessBadge />)

    await waitFor(() => {
      expect(screen.getByText('Readiness unavailable')).toBeInTheDocument()
    })
  })

  it('shows the green ready state when the endpoint returns pass', async () => {
    vi.mocked(api).mockResolvedValueOnce({ status: 'pass', issues: [] })

    render(<WorkflowReadinessBadge />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Production readiness: Production Ready' })).toBeInTheDocument()
    })
  })

  it('publishes results and coalesces rapid semantic revisions into one refetch', async () => {
    const onResult = vi.fn()
    vi.mocked(api).mockResolvedValue({ status: 'pass', issues: [] })
    render(<WorkflowReadinessBadge onResult={onResult} />)
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'pass', issues: [] }))

    vi.mocked(api).mockClear()
    useWorkflowStore.setState({ workflowRevision: 1 })
    useWorkflowStore.setState({ workflowRevision: 2 })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(onResult).toHaveBeenCalledWith(null)
  })

  it('deep-links a retry blocker to the selected node resilience controls', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      status: 'fail',
      issues: [{
        code: 'external_node_missing_retry',
        severity: 'fail',
        message: 'Missing retry policy',
        nodeId: '1',
        suggestion: 'Set retry.maxAttempts.',
      }],
    })

    render(<WorkflowReadinessBadge />)

    const summary = await screen.findByRole('button', { name: 'Production readiness: 1 blocker' })
    fireEvent.click(summary)
    fireEvent.click(await screen.findByRole('button', { name: 'Open resilience controls' }))

    expect(useWorkflowStore.getState().selectedNodeId).toBe('1')
    expect(useWorkflowStore.getState().activeTab).toBe('inspector')
    expect(consumeResilienceFocus('1')).toBe(true)
  })

  it('does not offer a dead link for readiness blockers on unsupported AI nodes', async () => {
    useWorkflowStore.setState({
      nodes: [{
        id: 'summarise',
        type: 'workflowStep',
        position: { x: 0, y: 0 },
        data: { label: 'Summarise', type: 'ai', config: {} },
      }],
    })
    vi.mocked(api).mockResolvedValueOnce({
      status: 'fail',
      issues: [{
        code: 'external_node_missing_retry',
        severity: 'fail',
        message: 'Missing retry policy',
        nodeId: 'summarise',
      }],
    })

    render(<WorkflowReadinessBadge />)

    fireEvent.click(await screen.findByRole('button', { name: 'Production readiness: 1 blocker' }))
    expect(screen.queryByRole('button', { name: 'Open resilience controls' })).toBeNull()
  })
})
