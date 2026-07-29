import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkflowGraphNode } from '../types'
import { AuthoringPanel, type AuthoringPanelModel } from './AuthoringPanel'

vi.mock('./InspectorPanel', () => ({
  InspectorPanel: ({ selectedNode }: { selectedNode: WorkflowGraphNode | null }) => (
    <div data-testid="inspector-scope">{selectedNode?.id ?? 'workflow'}</div>
  ),
}))
vi.mock('./AuthoringProblemsPanel', () => ({
  AuthoringProblemsPanel: ({ onOpenProblem }: { onOpenProblem?: () => void }) => (
    <button type="button" data-testid="problems-scope" onClick={onOpenProblem}>Problems</button>
  ),
}))
vi.mock('./VersionHistoryPanel', () => ({ VersionHistoryPanel: () => null }))
vi.mock('./WorkflowRolloutPanel', () => ({ WorkflowRolloutPanel: () => null }))
vi.mock('./WorkflowSloPanel', () => ({ WorkflowSloPanel: () => null }))
vi.mock('./ScheduleHistoryPanel', () => ({ ScheduleHistoryPanel: () => null }))
vi.mock('./WorkflowMetadataPanel', () => ({ WorkflowMetadataPanel: () => null }))

function model(overrides: Partial<AuthoringPanelModel> = {}): AuthoringPanelModel {
  return {
    runNodes: [],
    selectedNode: null,
    selectedEdge: null,
    workflowNodes: [],
    workflowEdges: [],
    validationIssues: [],
    readinessResult: null,
    aiReviewIssues: [],
    tools: [],
    workflows: [],
    currentWorkflowId: 'draft',
    currentWorkflowName: 'Draft',
    onUpdateNodeConfig: vi.fn(),
    onUpdateNodeType: vi.fn(),
    onUpdateEdgeCondition: vi.fn(),
    onValidateWorkflow: vi.fn(async () => true),
    onInsertSnippet: vi.fn(),
    ...overrides,
  }
}

describe('<AuthoringPanel />', () => {
  it('separates workflow, selected-step, and problem scopes', () => {
    const view = render(
      <AuthoringPanel model={model()} canWrite canUseAi onOpenAiAction={vi.fn()} />,
    )

    expect(screen.getByRole('button', { name: 'Step' })).toBeDisabled()
    expect(screen.getByTestId('inspector-scope')).toHaveTextContent('workflow')

    const selectedNode = {
      id: 'fetch',
      type: 'workflowStep',
      position: { x: 0, y: 0 },
      data: { label: 'Fetch', type: 'http', config: {} },
    } as WorkflowGraphNode
    view.rerender(
      <AuthoringPanel
        model={model({ selectedNode, workflowNodes: [selectedNode] })}
        canWrite
        canUseAi
        onOpenAiAction={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Step' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('inspector-scope')).toHaveTextContent('fetch')

    fireEvent.click(screen.getByRole('button', { name: 'Problems' }))
    expect(screen.getByTestId('problems-scope')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('problems-scope'))
    expect(screen.getByRole('button', { name: 'Step' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('inspector-scope')).toHaveTextContent('fetch')
  })

  it('exposes the four AI actions from the build context', () => {
    const onOpenAiAction = vi.fn()
    render(
      <AuthoringPanel model={model()} canWrite canUseAi onOpenAiAction={onOpenAiAction} />,
    )

    for (const label of ['Generate', 'Explain', 'Review', 'Fix']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }))
    expect(onOpenAiAction).toHaveBeenCalledWith('fix')
  })
})
