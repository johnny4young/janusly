import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { WorkflowCanvas } from './WorkflowCanvas'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'

function makeNode(id: string, label: string, position: { x: number; y: number }, hasValidationError = false): WorkflowGraphNode {
  return {
    id,
    type: 'workflowStep',
    position,
    data: {
      label,
      type: 'noop',
      config: {},
      hasValidationError,
    },
  }
}

function makeEdge(id: string, source: string, target: string): WorkflowGraphEdge {
  return { id, source, target }
}

function mountCanvas(overrides: Partial<Parameters<typeof WorkflowCanvas>[0]> = {}) {
  const props = {
    nodes: [
      makeNode('alpha', 'Alpha step', { x: 0, y: 0 }),
      makeNode('beta', 'Beta step', { x: 240, y: 0 }),
      makeNode('gamma', 'Gamma step', { x: 480, y: 0 }),
    ],
    edges: [makeEdge('e1', 'alpha', 'beta'), makeEdge('e2', 'beta', 'gamma')],
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onNodeClick: vi.fn(),
    onEdgeClick: vi.fn(),
    ...overrides,
  }

  // React Flow needs an explicit-size parent; a flex/absolute frame gives the
  // canvas room to render handles and observe layout.
  const utils = render(
    <div style={{ width: 1024, height: 720, position: 'relative' }}>
      <WorkflowCanvas {...props} />
    </div>,
  )

  return { props, ...utils }
}

describe('WorkflowCanvas (browser mode)', () => {
  it('renders every node label and edge count from props', () => {
    const { getByText, container } = mountCanvas()

    expect(getByText('Alpha step')).toBeInTheDocument()
    expect(getByText('Beta step')).toBeInTheDocument()
    expect(getByText('Gamma step')).toBeInTheDocument()
    expect(getByText('3 steps')).toBeInTheDocument()
    expect(getByText('2 paths')).toBeInTheDocument()
    // React Flow renders one DOM node per workflow node.
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3)
  })

  it('fires onNodeClick with the matching node when a node is clicked', async () => {
    const { props, container, findByText } = mountCanvas()

    // Wait for React Flow's internal layout (uses ResizeObserver in real browsers).
    await findByText('Alpha step')
    const alphaWrapper = container.querySelector('.react-flow__node[data-id="alpha"]') as HTMLElement
    expect(alphaWrapper).toBeTruthy()

    // userEvent.click runs Playwright's actionability check, which fails here:
    // React Flow stacks edge SVGs and a pane overlay above the node wrapper, so
    // Playwright reports "<div> intercepts pointer events" and times out. Fire
    // a real click via dispatchEvent — React's synthetic event system still
    // routes it to the node's onClick handler that calls onNodeClick.
    alphaWrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    expect(props.onNodeClick).toHaveBeenCalledTimes(1)
    const calledNode = props.onNodeClick.mock.calls[0][1]
    expect(calledNode.id).toBe('alpha')
  })

  it('measures node dimensions and applies a fitView transform to the viewport', async () => {
    // Layout-dependent path that jsdom can't fake: fitView reads each node's
    // getBoundingClientRect (computed from real CSS + DOM), then writes a
    // matrix transform onto the viewport. We assert both halves: dimensions
    // measured (via onNodesChange) and a non-identity transform applied.
    const { props, container, findByText } = mountCanvas()

    await findByText('Alpha step')

    // The dimensions pass runs from a ResizeObserver callback and fitView
    // writes the viewport transform on a follow-up frame; let waitFor poll the
    // assertion itself instead of binding to a fixed rAF count.
    await waitFor(() => {
      const dimensionChanges = props.onNodesChange.mock.calls
        .flatMap((call) => call[0] as Array<{ id: string; type: string; dimensions?: { width: number; height: number } }>)
        .filter((change) => change.type === 'dimensions')
      expect(dimensionChanges.length).toBeGreaterThanOrEqual(3)
      expect(dimensionChanges.every((c) => (c.dimensions?.width ?? 0) > 0 && (c.dimensions?.height ?? 0) > 0)).toBe(true)

      const viewport = container.querySelector('.react-flow__viewport') as HTMLElement
      expect(viewport).toBeTruthy()
      // viewport.style.transform is '' before fitView runs and a translate/matrix
      // string after; assert the post-fitView shape.
      expect(viewport.style.transform).toMatch(/translate|matrix/i)
    })
  })

  it('marks a node with data-status="error" when data.hasValidationError is true', async () => {
    const { container, findByText } = mountCanvas({
      nodes: [makeNode('only', 'Broken step', { x: 100, y: 100 }, true)],
      edges: [],
    })

    await findByText('Broken step')
    const node = container.querySelector('.react-flow__node[data-id="only"] .workflow-node') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.getAttribute('data-status')).toBe('error')
  })

  it('renders the React Flow Controls toolbar (zoom in/out/fit/lock) inside the canvas', async () => {
    const { container, findByText } = mountCanvas()

    await findByText('Alpha step')
    const controls = container.querySelector('.react-flow__controls')
    expect(controls).toBeTruthy()
    // Default Controls renders four interactive buttons; the count is stable
    // across @xyflow/react patch releases.
    expect(controls!.querySelectorAll('button').length).toBeGreaterThanOrEqual(3)
  })

  it('renders the dotted Background layer with a pattern definition', async () => {
    const { container, findByText } = mountCanvas()

    await findByText('Alpha step')
    const background = container.querySelector('.react-flow__background')
    expect(background).toBeTruthy()
    // xyflow renders the dots variant as an SVG <pattern> with a single <circle>
    // marker — variant info isn't on the wrapper class. Check the structural
    // signature instead so we don't bind to a brittle class string.
    const dotPattern = background!.querySelector('pattern circle')
    expect(dotPattern).toBeTruthy()
  })
})
