import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { ReactFlowProvider, Position } from '@xyflow/react'
import { changeAppLanguage, initI18n } from '../i18n'

// React Flow's `EdgeLabelRenderer` portals into a `<div>` mounted by
// the full `<ReactFlow>` component. Mounting just `<ReactFlowProvider>`
// doesn't create that target, so for unit testing we stub the portal
// to a passthrough `<div>` that renders children in-place. The mock
// call is hoisted by vitest to before the WorkflowEdge import below.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react')
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <div data-testid="edge-label-renderer">{children}</div>,
  }
})

import { WorkflowEdge } from './WorkflowEdge'

// React Flow edges normally render inside an SVG owned by `<ReactFlow>`,
// but for unit purposes we only need the BaseEdge + EdgeLabelRenderer
// portal to work. Wrap in an SVG so the BaseEdge's `<path>` mounts.
function renderEdge(overrides: { selected?: boolean; hasCondition?: boolean } = {}) {
  return render(
    <ReactFlowProvider>
      <svg>
        <WorkflowEdge
          id="edge-1"
          source="a"
          target="b"
          sourceX={0}
          sourceY={0}
          targetX={100}
          targetY={100}
          sourcePosition={Position.Bottom}
          targetPosition={Position.Top}
          selected={overrides.selected ?? false}
          data={{ hasCondition: overrides.hasCondition ?? false }}
          markerEnd={undefined}
          // EdgeProps fields the BaseEdge doesn't read in this path
          source-x={0}
          source-y={0}
        />
      </svg>
    </ReactFlowProvider>,
  )
}

describe('<WorkflowEdge />', () => {
  beforeEach(() => {
    initI18n('en')
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the BaseEdge path with className "we-edge"', () => {
    const { container } = renderEdge()
    const path = container.querySelector('path.we-edge')
    expect(path).not.toBeNull()
  })

  it('reflects the selected prop on the data-selected attribute', () => {
    const { container, rerender } = renderEdge({ selected: false })
    let path = container.querySelector('path.we-edge')
    expect(path?.getAttribute('data-selected')).toBe('false')

    rerender(
      <ReactFlowProvider>
        <svg>
          <WorkflowEdge
            id="edge-1"
            source="a"
            target="b"
            sourceX={0}
            sourceY={0}
            targetX={100}
            targetY={100}
            sourcePosition={Position.Bottom}
            targetPosition={Position.Top}
            selected
            data={{ hasCondition: false }}
            markerEnd={undefined}
          />
        </svg>
      </ReactFlowProvider>,
    )

    path = container.querySelector('path.we-edge')
    expect(path?.getAttribute('data-selected')).toBe('true')
  })

  it('renders the condition label only when data.hasCondition is true', () => {
    const { container, rerender } = renderEdge({ hasCondition: false })
    expect(container.querySelector('.we-edge-label')).toBeNull()

    rerender(
      <ReactFlowProvider>
        <svg>
          <WorkflowEdge
            id="edge-1"
            source="a"
            target="b"
            sourceX={0}
            sourceY={0}
            targetX={100}
            targetY={100}
            sourcePosition={Position.Bottom}
            targetPosition={Position.Top}
            selected={false}
            data={{ hasCondition: true }}
            markerEnd={undefined}
          />
        </svg>
      </ReactFlowProvider>,
    )

    expect(screen.getByText('condition')).toBeInTheDocument()
  })

  it('re-resolves the condition label when the locale changes', async () => {
    renderEdge({ hasCondition: true })
    expect(screen.getByText('condition')).toBeInTheDocument()
    // Locale changes notify React subscribers; wrap
    // in `act` so the re-render is observable in the next microtask.
    await act(async () => {
      changeAppLanguage('es')
    })
    // Verifies the locale resolution happens INSIDE the component via
    // useT() — a stale closure in a parent memo wouldn't update here.
    await waitFor(() => expect(screen.getByText('condición')).toBeInTheDocument())
    await act(async () => {
      changeAppLanguage('en')
    })
  })
})
