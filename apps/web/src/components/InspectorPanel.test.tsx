/**
 * Regression tests for the Inspector's selection-change hygiene (fourth-wave
 * audit B-03): the uncontrolled edge-condition textarea must be keyed by edge
 * id (or React reuses the DOM node and edge B shows — and on blur COMMITS —
 * edge A's stale condition), and a JSON parse error from node A must not
 * linger under node B's card.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InspectorPanel } from './InspectorPanel'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'

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

    fireEvent.blur(second)
    expect(onUpdateEdgeCondition).toHaveBeenCalledWith('edge-b', 'context.b.output.count > 0')
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
})
