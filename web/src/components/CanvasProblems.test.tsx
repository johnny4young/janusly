import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowStore } from '../store'
import { useAuthoringScopeRequest } from './authoring-focus-bus'
import type { AuthoringProblem } from './authoring-problems'
import { CanvasProblemsBand, CanvasProblemsChip } from './CanvasProblems'

const initialState = useWorkflowStore.getState()

function problem(overrides: Partial<AuthoringProblem> & { code: string }): AuthoringProblem {
  return {
    id: overrides.code,
    severity: 'warn',
    message: overrides.code,
    sources: ['readiness'],
    primarySource: 'readiness',
    ...overrides,
  }
}

function requestedScope() {
  const onScope = vi.fn()
  renderHook(() => useAuthoringScopeRequest(onScope)).unmount()
  return onScope.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  useWorkflowStore.setState({ ...initialState, activeTab: 'ai-studio', selectedNodeId: null, selectedEdgeId: null }, true)
})

describe('<CanvasProblemsChip />', () => {
  it('renders nothing without problems', () => {
    render(<CanvasProblemsChip problems={[]} />)
    expect(screen.queryByTestId('canvas-problems-chip')).toBeNull()
  })

  it('takes the worst severity and opens the Problems list from any canvas tab', () => {
    render(<CanvasProblemsChip problems={[problem({ code: 'a', severity: 'fail' }), problem({ code: 'b' })]} />)
    const chip = screen.getByTestId('canvas-problems-chip')
    expect(chip).toHaveTextContent('Problems 2')
    expect(chip).toHaveAttribute('data-severity', 'fail')
    fireEvent.click(chip)
    expect(useWorkflowStore.getState().activeTab).toBe('inspector')
    expect(requestedScope()).toBe('problems')
  })
})

describe('<CanvasProblemsBand />', () => {
  it('leaves step problems to their dots', () => {
    render(<CanvasProblemsBand problems={[problem({ code: 'a', nodeId: 'n' })]} />)
    expect(screen.queryByTestId('canvas-problems-band')).toBeNull()
  })

  it('localizes a known code and jumps to its element', () => {
    render(<CanvasProblemsBand problems={[problem({ code: 'workflow_missing_outputs' })]} />)
    const item = screen.getByTestId('canvas-problem-workflow_missing_outputs')
    expect(item).toHaveTextContent("Workflow doesn't declare any outputs")
    fireEvent.click(item)
    expect(useWorkflowStore.getState().activeTab).toBe('inspector')
    expect(requestedScope()).toBe('workflow')
  })

  it('opens a path problem on its path', () => {
    render(<CanvasProblemsBand problems={[problem({ code: 'edge_invalid_condition', edgeId: 'e1' })]} />)
    fireEvent.click(screen.getByTestId('canvas-problem-edge_invalid_condition'))
    expect(useWorkflowStore.getState().selectedEdgeId).toBe('e1')
    expect(requestedScope()).toBe('step')
  })

  it('falls back to the Problems list when a workflow problem has no element', () => {
    render(<CanvasProblemsBand problems={[problem({ code: 'workflow_missing_evals' })]} />)
    fireEvent.click(screen.getByTestId('canvas-problem-workflow_missing_evals'))
    expect(requestedScope()).toBe('problems')
  })

  it('caps the band and sends the rest to the Problems list', () => {
    render(<CanvasProblemsBand problems={[problem({ code: 'a' }), problem({ code: 'b' }), problem({ code: 'c' }), problem({ code: 'd' })]} />)
    expect(screen.queryByTestId('canvas-problem-c')).toBeNull()
    const more = screen.getByTestId('canvas-problems-more')
    expect(more).toHaveTextContent('+2')
    fireEvent.click(more)
    expect(requestedScope()).toBe('problems')
  })
})
