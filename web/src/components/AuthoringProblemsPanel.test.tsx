import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowStore } from '../store'
import { useAuthoringScopeRequest } from './authoring-focus-bus'
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { consumeResilienceFocus } from './resilience-focus-bus'

const initialState = useWorkflowStore.getState()

function requestedScope() {
  const onScope = vi.fn()
  renderHook(() => useAuthoringScopeRequest(onScope)).unmount()
  return onScope.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  sessionStorage.clear()
  useWorkflowStore.setState({
    ...initialState,
    activeTab: 'inspector',
    selectedNodeId: null,
    selectedEdgeId: null,
  }, true)
})

describe('<AuthoringProblemsPanel />', () => {
  it('navigates node and edge findings with keyboard-accessible buttons', () => {
    const { rerender } = render(
      <AuthoringProblemsPanel
        validationIssues={[{ code: 'condition_invalid_expression', message: 'Bad', nodeId: 'gate' }]}
        readiness={null}
        aiReviewIssues={[]}
        workflowEdges={[]}
        onValidate={vi.fn(async () => false)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on step gate' }))
    expect(useWorkflowStore.getState().selectedNodeId).toBe('gate')
    expect(requestedScope()).toBe('step')

    rerender(
      <AuthoringProblemsPanel
        validationIssues={[{ code: 'edge_invalid_condition', message: 'Bad edge', edgeId: 'path-a' }]}
        readiness={null}
        aiReviewIssues={[]}
        workflowEdges={[{ id: 'path-a', source: 'first', target: 'second', data: {} }]}
        onValidate={vi.fn(async () => false)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on path path-a' }))
    expect(useWorkflowStore.getState().selectedEdgeId).toBe('path-a')
    expect(requestedScope()).toBe('step')
  })

  it('reuses the resilience fieldset handoff for readiness findings', () => {
    render(
      <AuthoringProblemsPanel
        validationIssues={[]}
        readiness={{
          status: 'fail',
          issues: [{ code: 'http_missing_bounds', severity: 'fail', message: 'Bounds', nodeId: 'fetch' }],
        }}
        aiReviewIssues={[]}
        workflowEdges={[]}
        onValidate={vi.fn(async () => false)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on step fetch' }))
    expect(consumeResilienceFocus('fetch')).toBe(true)
  })

  it('links a workflow-level finding only when it has an element to open', () => {
    render(
      <AuthoringProblemsPanel
        validationIssues={[]}
        readiness={{
          status: 'warn',
          issues: [
            { code: 'workflow_missing_outputs', severity: 'warn', message: 'Outputs' },
            { code: 'workflow_missing_evals', severity: 'warn', message: 'Evals' },
          ],
        }}
        aiReviewIssues={[]}
        workflowEdges={[]}
        onValidate={vi.fn(async () => false)}
      />,
    )
    expect(screen.queryByTestId('authoring-problem-workflow_missing_evals')).toBeNull()
    fireEvent.click(screen.getByTestId('authoring-problem-workflow_missing_outputs'))
    expect(requestedScope()).toBe('workflow')
  })

  it('runs structural validation and renders the all-clear state', async () => {
    const onValidate = vi.fn(async () => true)
    render(
      <AuthoringProblemsPanel
        validationIssues={[]}
        readiness={{ status: 'pass', issues: [] }}
        aiReviewIssues={[]}
        workflowEdges={[]}
        onValidate={onValidate}
      />,
    )
    expect(screen.getByTestId('authoring-problems-empty')).toHaveTextContent('No authoring problems found.')
    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }))
    await waitFor(() => expect(onValidate).toHaveBeenCalledOnce())
  })

  it('maps a serialized server edge index to the live React Flow edge', () => {
    render(
      <AuthoringProblemsPanel
        validationIssues={[{ code: 'edge_invalid_condition', message: 'Bad edge', edgeId: 'edge_0' }]}
        readiness={null}
        aiReviewIssues={[]}
        workflowEdges={[{ id: 'e0', source: 'first', target: 'second', data: {} }]}
        onValidate={vi.fn(async () => false)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on path e0' }))
    expect(useWorkflowStore.getState().selectedEdgeId).toBe('e0')
  })
})
