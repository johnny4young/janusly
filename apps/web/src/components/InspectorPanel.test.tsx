/**
 * Regression tests for Inspector selection-change hygiene: each selected edge
 * shows its own controlled condition, and a JSON parse error from node A must
 * not linger under node B's card.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InspectorPanel } from './InspectorPanel'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { requestAuthoringFocus } from './authoring-focus-bus'

function makeEdge(id: string, condition: string): WorkflowGraphEdge {
  return { id, source: `${id}-src`, target: `${id}-dst`, data: { condition } }
}

function makeNode(id: string): WorkflowGraphNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { type: 'noop', config: {} },
  } as WorkflowGraphNode
}

function renderPanel(overrides: Partial<Parameters<typeof InspectorPanel>[0]> = {}) {
  const props: Parameters<typeof InspectorPanel>[0] = {
    selectedNode: null,
    selectedEdge: null,
    runNodes: [],
    validationIssues: [],
    tools: [],
    workflowNodes: [],
    workflowEdges: [],
    onUpdateNodeConfig: vi.fn(),
    onUpdateNodeType: vi.fn(),
    onUpdateEdgeCondition: vi.fn(),
    onInsertSnippet: vi.fn(),
    ...overrides,
  }
  return { ...render(<InspectorPanel {...props} />), props }
}

describe('<InspectorPanel /> selection-change hygiene', () => {
  it('shows the newly selected edge\'s own condition, not the previous edge\'s text', () => {
    const onUpdateEdgeCondition = vi.fn()
    const { rerender, props } = renderPanel({
      selectedEdge: makeEdge('edge-a', 'context.a.output.ok === true'),
      onUpdateEdgeCondition,
    })

    const first = screen.getByLabelText(/run only when/i) as HTMLTextAreaElement
    expect(first.value).toBe('context.a.output.ok === true')

    rerender(
      <InspectorPanel
        {...props}
        selectedEdge={makeEdge('edge-b', 'context.b.output.count > 0')}
      />,
    )

    const second = screen.getByLabelText(/run only when/i) as HTMLTextAreaElement
    // Without key={selectedEdge.id} React reuses the uncontrolled textarea and
    // this still reads edge A's text — which blur would then WRITE onto edge B.
    expect(second.value).toBe('context.b.output.count > 0')

    fireEvent.change(second, { target: { value: 'context.b.output.count >= 1' } })
    expect(onUpdateEdgeCondition).toHaveBeenCalledWith('edge-b', 'context.b.output.count >= 1')
    expect(onUpdateEdgeCondition).not.toHaveBeenCalledWith('edge-b', 'context.a.output.ok === true')
  })

  it('clears the advanced-JSON parse error when the selection moves to another node', () => {
    const { rerender, props } = renderPanel({ selectedNode: makeNode('node-a') })

    const jsonField = document.getElementById('node-config') as HTMLTextAreaElement
    fireEvent.blur(jsonField, { target: { value: '{ not json' } })
    expect(document.querySelector('.issue-error')).not.toBeNull()

    rerender(<InspectorPanel {...props} selectedNode={makeNode('node-b')} />)

    // Node B never had a parse error; node A's banner must not follow it.
    expect(document.querySelector('.issue-error')).toBeNull()
  })

  it('moves focus to the exact selected entity requested by Problems', async () => {
    const node = makeNode('node-a')
    requestAuthoringFocus({ kind: 'node', id: 'node-a' })
    renderPanel({ selectedNode: node, workflowNodes: [node] })
    await waitFor(() => expect(screen.getByTestId('inspector-node-node-a')).toHaveFocus())
  })
})

describe('<InspectorPanel /> failed-node header', () => {
  it('surfaces the error message + attempt · duration when the selected node failed', () => {
    renderPanel({
      selectedNode: makeNode('http_call'),
      runNodes: [{
        nodeId: 'http_call',
        status: 'failed',
        errorJson: { message: 'HTTP 500 from upstream' },
        attempts: 2,
        startedAt: '2026-07-09T10:00:00.000Z',
        finishedAt: '2026-07-09T10:00:05.000Z',
      }],
    })

    const failure = screen.getByTestId('inspector-failed-node')
    expect(failure).toHaveTextContent('HTTP 500 from upstream')
    expect(failure).toHaveTextContent('attempt 2')
    expect(failure).toHaveTextContent('5s')
  })

  it('renders no failure block for a succeeded node', () => {
    renderPanel({
      selectedNode: makeNode('ok_node'),
      runNodes: [{ nodeId: 'ok_node', status: 'succeeded' }],
    })

    expect(screen.queryByTestId('inspector-failed-node')).toBeNull()
  })
})
