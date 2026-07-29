
import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { WorkflowCanvas } from './WorkflowCanvas'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'

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
      <ReactFlowProvider>
        <WorkflowCanvas {...props} />
      </ReactFlowProvider>
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

  it('falls back to the localized kind name for a whitespace-only custom label', async () => {
    const { findByText, queryByText } = mountCanvas({
      nodes: [makeNode('blank-label', '   ', { x: 100, y: 100 })],
      edges: [],
    })

    expect(await findByText('Do nothing')).toBeInTheDocument()
    expect(queryByText(/^\s+$/)).toBeNull()
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

    const onNodeClick = vi.mocked(props.onNodeClick)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    const calledNode = onNodeClick.mock.calls[0][1]
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
      const dimensionChanges = vi.mocked(props.onNodesChange).mock.calls
        .flatMap((call) => call[0])
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

  it('accepts a palette drop at the pointer while retaining click-based authoring', async () => {
    const onAddNode = vi.fn()
    const { container, findByText } = mountCanvas({
      onAddNode,
    })
    await findByText('Alpha step')
    const pane = container.querySelector('.react-flow__pane') as HTMLElement
    const bounds = pane.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-janusly-node-type', 'http')

    pane.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: bounds.left + 700,
      clientY: bounds.top + 420,
    }))
    pane.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: bounds.left + 700,
      clientY: bounds.top + 420,
    }))

    expect(onAddNode).toHaveBeenCalledTimes(1)
    expect(onAddNode).toHaveBeenCalledWith('http', {
      x: expect.any(Number),
      y: expect.any(Number),
    })
    const position = onAddNode.mock.calls[0][1]
    expect(Number.isFinite(position.x)).toBe(true)
    expect(Number.isFinite(position.y)).toBe(true)
  })

  it('does not create a node when a palette payload is dropped on canvas chrome', async () => {
    const onAddNode = vi.fn()
    const nodes = Array.from({ length: 6 }, (_, index) => makeNode(
      `chrome-${index}`,
      index === 0 ? 'Alpha step' : `Chrome ${index}`,
      { x: index * 140, y: 0 },
    ))
    const { container, findByText } = mountCanvas({
      nodes,
      edges: [],
      onAddNode,
    })
    await findByText('Alpha step')
    const targets = [
      container.querySelector('.canvas-toolbar'),
      container.querySelector('.canvas-step-picker'),
      container.querySelector('.react-flow__controls'),
      container.querySelector('.react-flow__minimap'),
    ]

    for (const target of targets) {
      expect(target).toBeTruthy()
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-janusly-node-type', 'http')
      target!.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: 32,
        clientY: 32,
      }))
    }

    expect(onAddNode).not.toHaveBeenCalled()
  })

  it('lets the blank-canvas teaching card pass a first palette drop through to the flow surface', async () => {
    const onAddNode = vi.fn()
    const { findByTestId } = mountCanvas({
      nodes: [],
      edges: [],
      onAddNode,
    })
    const empty = await findByTestId('canvas-empty')
    const card = empty.querySelector('.canvas-empty__card') as HTMLElement
    const bounds = card.getBoundingClientRect()
    // The browser-test viewport can clip the fixed-size 1024px canvas host;
    // choose a visible point inside the card rather than its off-screen center.
    const clientX = Math.min(bounds.left + 20, document.documentElement.clientWidth - 1)
    const clientY = Math.min(bounds.top + 20, document.documentElement.clientHeight - 1)
    const target = document.elementFromPoint(clientX, clientY)
    expect(target?.closest('.canvas-flow-surface')).toBeTruthy()

    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-janusly-node-type', 'http')
    target!.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY,
    }))

    expect(onAddNode).toHaveBeenCalledOnce()
    expect(onAddNode).toHaveBeenCalledWith('http', {
      x: expect.any(Number),
      y: expect.any(Number),
    })
  })

  it('reveals the interactive minimap only for larger authoring graphs', async () => {
    const fiveNodes = Array.from({ length: 5 }, (_, index) => makeNode(`small-${index}`, `Small ${index}`, { x: index * 140, y: 0 }))
    const small = mountCanvas({ nodes: fiveNodes, edges: [] })
    await small.findByText('Small 0')
    expect(small.queryByRole('img', { name: 'Workflow overview map' })).toBeNull()
    small.unmount()

    const sixNodes = Array.from({ length: 6 }, (_, index) => makeNode(`large-${index}`, `Large ${index}`, { x: index * 140, y: 0 }))
    const large = mountCanvas({ nodes: sixNodes, edges: [] })
    await large.findByText('Large 0')
    expect(await large.findByRole('img', { name: 'Workflow overview map' })).toBeInTheDocument()
  })

  it('renders run observation mode as immutable while keeping pan, zoom, focus, and live status visible', async () => {
    const running = makeNode('running', 'Running step', { x: 100, y: 100 })
    running.data.status = 'running'
    const waiting = makeNode('waiting', 'Waiting step', { x: 340, y: 100 })
    const { container, findByText, getByText } = mountCanvas({
      mode: 'observe',
      nodes: [running, waiting],
      edges: [makeEdge('running-waiting', 'running', 'waiting')],
    })

    await findByText('Running step')
    expect(getByText('Run snapshot')).toBeInTheDocument()
    expect(container.querySelector('.canvas-toolbar__meta .we-pill')).toHaveTextContent('Read only')
    const canvas = container.querySelector('[data-testid="run-observation-canvas"]') as HTMLElement
    const nodeWrapper = container.querySelector('.react-flow__node[data-id="running"]') as HTMLElement
    const node = nodeWrapper.querySelector('.workflow-node') as HTMLElement
    expect(canvas).toHaveAttribute('data-mode', 'observe')
    expect(nodeWrapper.classList.contains('draggable')).toBe(false)
    expect(node).toHaveAttribute('data-status', 'running')
    expect(getComputedStyle(node).animationName).toContain('we-running-node-pulse')
    expect(getComputedStyle(container.querySelector('.workflow-handle') as HTMLElement).display).toBe('none')
    expect(container.querySelector('.react-flow__controls-interactive')).toBeNull()
    const edgeWrapper = container.querySelector('.react-flow__edge[aria-label="Path from Running step to Waiting step"]') as HTMLElement
    expect(edgeWrapper).toBeTruthy()
    expect(nodeWrapper).toHaveAttribute('aria-label', 'Step: Running step. Status: Running. Read only')
    expect(document.getElementById(edgeWrapper.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Read only')
    expect(container.querySelector('[aria-label="Zoom in"]')).toBeTruthy()
  })

  it('centers blank-canvas insertion under a restored non-default zoom', async () => {
    initI18n('en')
    const storageKey = 'janusly:canvasViewport:wf-empty-zoom'
    window.localStorage.setItem(storageKey, JSON.stringify({ x: 0, y: 0, zoom: 0.5 }))
    const previous = useWorkflowStore.getState()
    useWorkflowStore.setState({ nodes: [], edges: [], workflowDirty: false })
    try {
      const props = {
        nodes: [],
        edges: [],
        onNodesChange: vi.fn(),
        onEdgesChange: vi.fn(),
        onConnect: vi.fn(),
        onNodeClick: vi.fn(),
        onEdgeClick: vi.fn(),
        onAddNode: (type: string) => useWorkflowStore.getState().addNode(type),
        viewportWorkflowId: 'wf-empty-zoom',
      }
      const { container, getByRole, findByRole } = render(
        <ReactFlowProvider>
          <div style={{ width: 1024, height: 720, position: 'relative' }}>
            <WorkflowCanvas {...props} />
          </div>
        </ReactFlowProvider>,
      )

      await waitFor(() => {
        const viewport = container.querySelector('.react-flow__viewport') as HTMLElement
        expect(viewport.style.transform).toMatch(/translate\(\s*0px,\s*0px\s*\)\s*scale\(\s*0\.5\s*\)/)
      })
      getByRole('button', { name: 'Add step' }).click()
      const doNothing = await findByRole('button', { name: /^Do nothing/ })
      doNothing.click()

      const [added] = useWorkflowStore.getState().nodes
      expect(added.position.x).toBeCloseTo(905, 0)
      expect(added.position.y).toBeCloseTo(672, 0)
    } finally {
      window.localStorage.removeItem(storageKey)
      useWorkflowStore.setState({
        nodes: previous.nodes,
        edges: previous.edges,
        workflowDirty: previous.workflowDirty,
        workflowRevision: previous.workflowRevision,
      })
    }
  })

  it('hides authoring controls when the current user has read-only access', async () => {
    const { findByText, queryByRole, container } = mountCanvas({
      readOnly: true,
      onAddNode: vi.fn(),
    })

    await findByText('Alpha step')
    expect(queryByRole('button', { name: 'Add step' })).toBeNull()
    expect(container.querySelector('.react-flow__node[data-id="alpha"]'))
      .not.toHaveClass('draggable')
  })

  it('localizes observe-mode controls, edge names, and read-only instructions in Spanish', async () => {
    initI18n('es')
    const { container, findByText } = mountCanvas({
      mode: 'observe',
      nodes: [
        makeNode('inicio', 'Inicio', { x: 100, y: 100 }),
        makeNode('fin', 'Final', { x: 340, y: 100 }),
      ],
      edges: [makeEdge('inicio-fin', 'inicio', 'fin')],
    })

    await findByText('Inicio')
    const nodeWrapper = container.querySelector('.react-flow__node[data-id="inicio"]') as HTMLElement
    const edgeWrapper = container.querySelector('.react-flow__edge[aria-label="Camino de Inicio a Final"]') as HTMLElement
    expect(edgeWrapper).toBeTruthy()
    expect(nodeWrapper).toHaveAttribute('aria-label', 'Paso: Inicio. Estado: Listo. Solo lectura')
    expect(document.getElementById(edgeWrapper.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Solo lectura')
    expect(container.querySelector('[aria-label="Instantánea de la ejecución"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Acercar"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Alejar"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Ajustar ejecución a la vista"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Press delete')
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

  it('preserves the viewport across a display:none hide/show cycle (operations-cycle mechanism)', async () => {
    // The production layout hides the canvas via `display: none` on non-canvas
    // non-home tabs (e.g. operations) WITHOUT unmounting it, so the <ReactFlow>
    // instance — and its viewport — survives `inspector -> operations ->
    // inspector`. Mirror that here: render under <ReactFlowProvider> (as the
    // lazy CanvasWorkspace does), capture the post-fitView viewport, toggle the
    // wrapper's `display` off and back on, and assert the SAME viewport element
    // is still mounted with the SAME transform. A style toggle never unmounts a
    // React subtree, so a changed element identity here would mean the canvas
    // remounted and `fitView` re-ran — i.e. the viewport invariant regressed.
    const props = {
      nodes: [
        makeNode('alpha', 'Alpha step', { x: 0, y: 0 }),
        makeNode('beta', 'Beta step', { x: 240, y: 0 }),
      ],
      edges: [makeEdge('e1', 'alpha', 'beta')],
      onNodesChange: vi.fn(),
      onEdgesChange: vi.fn(),
      onConnect: vi.fn(),
      onNodeClick: vi.fn(),
      onEdgeClick: vi.fn(),
    }
    const { container, findByText } = render(
      <ReactFlowProvider>
        <div data-testid="canvas-host" style={{ width: 1024, height: 720, position: 'relative' }}>
          <WorkflowCanvas {...props} />
        </div>
      </ReactFlowProvider>,
    )
    await findByText('Alpha step')

    let viewportBefore!: HTMLElement
    await waitFor(() => {
      viewportBefore = container.querySelector('.react-flow__viewport') as HTMLElement
      expect(viewportBefore).toBeTruthy()
      expect(viewportBefore.style.transform).toMatch(/translate|matrix/i)
    })
    const transformBefore = viewportBefore.style.transform

    const host = container.querySelector('[data-testid="canvas-host"]') as HTMLElement
    host.style.display = 'none'
    host.style.display = ''

    // Read synchronously — ResizeObserver callbacks are async, so no re-fit can
    // race this assertion. Same DOM node => the instance was never unmounted.
    const viewportAfter = container.querySelector('.react-flow__viewport') as HTMLElement
    expect(viewportAfter).toBe(viewportBefore)
    expect(viewportAfter.style.transform).toBe(transformBefore)
  })

  it('restores a saved viewport (defaultViewport) instead of fitting to view when viewportWorkflowId is set', async () => {
    // Seed a saved viewport, then mount with that workflow key. The canvas
    // adopts it as `defaultViewport` and SKIPS `fitView`, so the
    // `.react-flow__viewport` transform carries the seeded zoom (1.25) — a value
    // an auto-fit of these nodes in a 1024x720 frame would not produce. The
    // other tests pass no key, so they keep the fitView path.
    const STORAGE_KEY = 'janusly:canvasViewport:wf-restore'
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 123, y: -45, zoom: 1.25 }))
    try {
      const props = {
        nodes: [
          makeNode('alpha', 'Alpha step', { x: 0, y: 0 }),
          makeNode('beta', 'Beta step', { x: 240, y: 0 }),
        ],
        edges: [makeEdge('e1', 'alpha', 'beta')],
        onNodesChange: vi.fn(),
        onEdgesChange: vi.fn(),
        onConnect: vi.fn(),
        onNodeClick: vi.fn(),
        onEdgeClick: vi.fn(),
        viewportWorkflowId: 'wf-restore',
      }
      const { container, findByText } = render(
        <ReactFlowProvider>
          <div style={{ width: 1024, height: 720, position: 'relative' }}>
            <WorkflowCanvas {...props} />
          </div>
        </ReactFlowProvider>,
      )
      await findByText('Alpha step')

      await waitFor(() => {
        const viewport = container.querySelector('.react-flow__viewport') as HTMLElement
        expect(viewport).toBeTruthy()
        // React Flow renders the viewport as `translate(Xpx, Ypx) scale(Z)`.
        expect(viewport.style.transform).toMatch(/translate\(\s*123px,\s*-45px\s*\)\s*scale\(\s*1\.25\s*\)/)
      })
    } finally {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  })

  it('persists Control Panel zoom changes for a saved workflow', async () => {
    // React Flow's built-in Controls produce a null onMoveEnd source event, the
    // same shape used by automatic fit/restore. The canvas therefore persists
    // toolbar zoom/fit explicitly through the Controls callbacks.
    const STORAGE_KEY = 'janusly:canvasViewport:wf-controls'
    window.localStorage.removeItem(STORAGE_KEY)
    try {
      const props = {
        nodes: [makeNode('alpha', 'Alpha step', { x: 0, y: 0 })],
        edges: [],
        onNodesChange: vi.fn(),
        onEdgesChange: vi.fn(),
        onConnect: vi.fn(),
        onNodeClick: vi.fn(),
        onEdgeClick: vi.fn(),
        viewportWorkflowId: 'wf-controls',
      }
      const { findByText, getByLabelText } = render(
        <ReactFlowProvider>
          <div style={{ width: 1024, height: 720, position: 'relative' }}>
            <WorkflowCanvas {...props} />
          </div>
        </ReactFlowProvider>,
      )
      await findByText('Alpha step')

      getByLabelText('Zoom Out').click()

      await waitFor(() => {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        expect(raw).toBeTruthy()
        const saved = JSON.parse(raw!)
        expect(Number.isFinite(saved.x)).toBe(true)
        expect(Number.isFinite(saved.y)).toBe(true)
        expect(Number.isFinite(saved.zoom)).toBe(true)
        expect(saved.zoom).toBeGreaterThan(0)
      })
    } finally {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  })
})
