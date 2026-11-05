import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkflowGraphNode } from '../types'
import { requestAuthoringScope } from './authoring-focus-bus'
import { AuthoringPanel, type AuthoringPanelModel } from './AuthoringPanel'

vi.mock('./InspectorPanel', () => ({
  InspectorPanel: ({ selectedNode }: { selectedNode: WorkflowGraphNode | null }) => (
    <div data-testid="inspector-scope">{selectedNode?.id ?? 'workflow'}</div>
  ),
}))
vi.mock('./AuthoringProblemsPanel', () => ({
  AuthoringProblemsPanel: () => <div data-testid="problems-scope">Problems</div>,
}))
vi.mock('./WorkflowOperationsPanel', () => ({
  WorkflowOperationsPanel: () => <div data-testid="workflow-operations" />,
}))

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
    onUpdateEdgeOnError: vi.fn(),
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
    expect(screen.getByTestId('workflow-operations')).toBeInTheDocument()

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
    act(() => requestAuthoringScope('step'))
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

  it('opens on the scope tabs with the AI actions as a named toolbar below them', () => {
    const onOpenAiAction = vi.fn()
    render(
      <AuthoringPanel model={model()} canWrite canUseAi onOpenAiAction={onOpenAiAction} />,
    )

    const toolbar = screen.getByRole('region', { name: 'Ask Janusly' })
    expect(toolbar).toHaveAttribute('data-testid', 'authoring-ai-toolbar')
    const tabs = screen.getByRole('navigation', { name: 'Authoring scope' })
    expect(tabs.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toolbar.compareDocumentPosition(screen.getByTestId('inspector-scope')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    for (const action of ['generate', 'explain', 'review', 'fix'] as const) {
      fireEvent.click(within(toolbar).getByTestId(`authoring-ai-${action}`))
      expect(onOpenAiAction).toHaveBeenLastCalledWith(action)
    }
  })

  it('hides the AI toolbar without the AI permission and keeps the scope tabs', () => {
    render(
      <AuthoringPanel model={model()} canWrite canUseAi={false} onOpenAiAction={vi.fn()} />,
    )

    expect(screen.queryByTestId('authoring-ai-toolbar')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Authoring scope' })).toBeInTheDocument()
  })

  it('opens the canonical Problems scope from the header handoff', () => {
    render(
      <AuthoringPanel model={model()} canWrite canUseAi onOpenAiAction={vi.fn()} />,
    )

    act(() => document.querySelector<HTMLButtonElement>('.authoring-scope-nav button:last-of-type')?.click())

    expect(screen.getAllByRole('button', { name: 'Problems' })
      .find((button) => button.getAttribute('aria-current') === 'page'))
      .toBeInTheDocument()
    expect(screen.getByTestId('problems-scope')).toBeInTheDocument()
  })

  it('honours a jump requested before the lazy panel mounted, over its selection default', () => {
    const selectedNode = {
      id: 'fetch',
      type: 'workflowStep',
      position: { x: 0, y: 0 },
      data: { label: 'Fetch', type: 'http', config: {} },
    } as WorkflowGraphNode
    requestAuthoringScope('problems')
    render(
      <StrictMode>
        <AuthoringPanel model={model({ selectedNode })} canWrite canUseAi onOpenAiAction={vi.fn()} />
      </StrictMode>,
    )

    expect(screen.getByTestId('problems-scope')).toBeInTheDocument()
  })

  it('moves the mounted panel when a jump arrives, including back to the selected step', () => {
    const selectedNode = {
      id: 'fetch',
      type: 'workflowStep',
      position: { x: 0, y: 0 },
      data: { label: 'Fetch', type: 'http', config: {} },
    } as WorkflowGraphNode
    render(<AuthoringPanel model={model({ selectedNode })} canWrite canUseAi onOpenAiAction={vi.fn()} />)

    act(() => requestAuthoringScope('workflow', 'outputs'))
    expect(screen.getByTestId('workflow-operations')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-scope')).toHaveTextContent('workflow')

    act(() => requestAuthoringScope('step'))
    expect(screen.getByTestId('inspector-scope')).toHaveTextContent('fetch')
  })

  it('counts a finding reported by two sources once, as the Problems list does', () => {
    render(
      <AuthoringPanel
        model={model({
          validationIssues: [{ code: 'workflow_missing_outputs', message: 'Outputs' }],
          readinessResult: {
            status: 'warn',
            issues: [{ code: 'workflow_missing_outputs', severity: 'warn', message: 'Outputs' }],
          },
        })}
        canWrite
        canUseAi
        onOpenAiAction={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-shortcut="authoring-problems"] small')).toHaveTextContent('1')
  })
})
