import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBumpCoalesceForTests, registerFlowOps, useWorkflowStore } from './store'

const initialState = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState(
    {
      ...initialState,
      session: null,
      user: null,
      userId: null,
      orgId: null,
      authReady: false,
      currentWorkflowId: 'ui-test',
      currentWorkflowName: 'Sample workflow',
      workflowRevision: 0,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      runId: null,
      runNodes: [],
      events: [],
      eventsCursor: null,
      eventsHasMore: false,
      activeTab: 'multiAgent',
      streamStatus: 'idle',
      toasts: [],
      platformVersion: 0,
      budgetBlocked: null,
    },
    true,
  )
})

describe('useWorkflowStore', () => {
  it('addNode appends a node with its preset config and an empty label (leaf component resolves)', () => {
    useWorkflowStore.getState().addNode('http')
    const { nodes } = useWorkflowStore.getState()
    expect(nodes).toHaveLength(1)
    expect(nodes[0].data.type).toBe('http')
    // `data.label` stays empty so `WorkflowStepNode` resolves it via
    // `getNodeLabel('http')` at render time — keeps locale toggles
    // out of the upstream `visibleNodes` memo dep array.
    expect(nodes[0].data.label).toBe('')
    expect(nodes[0].data.config).toEqual({ url: 'https://api.github.com' })
  })

  it('hydrateWorkflow loads nodes/edges and resets selection and run state', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf_1',
      name: 'Pipeline',
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'http', config: { url: 'https://example.com' } },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'true' }],
    })

    const state = useWorkflowStore.getState()
    expect(state.currentWorkflowId).toBe('wf_1')
    expect(state.currentWorkflowName).toBe('Pipeline')
    expect(state.nodes).toHaveLength(2)
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0].source).toBe('a')
    expect(state.edges[0].target).toBe('b')
    expect(state.edges[0].animated).toBe(true)
    expect(state.runId).toBeNull()
    // `data.label` stays empty after hydration — the canvas component
    // resolves the human label via `getNodeLabel(type)` at render
    // time. Regression-pin: a writer that reintroduces
    // `String(type).toUpperCase()` would shadow the locale-correct
    // label and the e2e tests would fail.
    expect(state.nodes[0].data.label).toBe('')
    expect(state.nodes[1].data.label).toBe('')
  })

  it('hydrates generated/template content as an unsaved dirty draft when requested', () => {
    useWorkflowStore.getState().hydrateWorkflow(
      { id: 'draft', name: 'Draft', nodes: [], edges: [] },
      { saved: false, dirty: true },
    )
    expect(useWorkflowStore.getState().currentWorkflowSaved).toBe(false)
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('getWorkflowJson serializes the graph back to the DAG contract', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf_2',
      name: 'Sample',
      nodes: [{ id: 'n1', type: 'noop', config: { foo: 'bar' } }],
      edges: [],
    })

    const dag = useWorkflowStore.getState().getWorkflowJson()
    expect(dag).toEqual({
      id: 'wf_2',
      name: 'Sample',
      nodes: [{ id: 'n1', type: 'noop', config: { foo: 'bar' } }],
      edges: [],
    })
  })

  it('updateSelectedNodeType swaps type and config with the matching preset', () => {
    useWorkflowStore.getState().addNode('noop')
    const id = useWorkflowStore.getState().nodes[0].id
    useWorkflowStore.getState().selectNode(id)
    useWorkflowStore.getState().updateSelectedNodeType('approval')

    const state = useWorkflowStore.getState()
    expect(state.nodes[0].data.type).toBe('approval')
    expect(state.nodes[0].data.config).toEqual({ message: 'Please approve this workflow step.' })
    // `data.label` stays empty after a type swap — the canvas component
    // resolves the new label via `getNodeLabel('approval')` at render
    // time, so the upstream visibleNodes memo doesn't carry locale deps.
    expect(state.nodes[0].data.label).toBe('')
  })

  it('updateSelectedNodeConfig only mutates the selected node', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [
        { id: 'a', type: 'noop', config: {} },
        { id: 'b', type: 'http', config: { url: 'https://example.com' } },
      ],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('a')
    useWorkflowStore.getState().updateSelectedNodeConfig({ retries: 3 })

    const nodes = useWorkflowStore.getState().nodes
    expect(nodes.find(n => n.id === 'a')?.data.config).toEqual({ retries: 3 })
    expect(nodes.find(n => n.id === 'b')?.data.config).toEqual({ url: 'https://example.com' })
  })

  it('addEvents merges events without duplicating by id', () => {
    useWorkflowStore.getState().addEvents([
      { id: 'evt_1', type: 'node.queued' },
      { id: 'evt_2', type: 'node.succeeded' },
    ])
    useWorkflowStore.getState().addEvents([
      { id: 'evt_2', type: 'node.succeeded' },
      { id: 'evt_3', type: 'node.failed' },
    ])

    const ids = useWorkflowStore.getState().events.map(event => event.id)
    expect(ids).toEqual(['evt_1', 'evt_2', 'evt_3'])
  })

  it('addEvents sorts merged events chronologically by createdAt', () => {
    useWorkflowStore.getState().addEvents([
      { id: 'evt_b', type: 'node.queued', createdAt: '2026-04-29T10:00:01.000Z' },
      { id: 'evt_a', type: 'node.queued', createdAt: '2026-04-29T10:00:00.000Z' },
    ])
    useWorkflowStore.getState().addEvents([
      { id: 'evt_old', type: 'run.started', createdAt: '2026-04-29T09:59:50.000Z' },
      { id: 'evt_c', type: 'node.succeeded', createdAt: '2026-04-29T10:00:02.000Z' },
    ])

    const ids = useWorkflowStore.getState().events.map(event => event.id)
    expect(ids).toEqual(['evt_old', 'evt_a', 'evt_b', 'evt_c'])
  })

  it('setEventsPagination updates cursor and hasMore', () => {
    useWorkflowStore.getState().setEventsPagination('2026-04-29T09:00:00.000Z', true)
    expect(useWorkflowStore.getState().eventsCursor).toBe('2026-04-29T09:00:00.000Z')
    expect(useWorkflowStore.getState().eventsHasMore).toBe(true)

    useWorkflowStore.getState().setEventsPagination(null, false)
    expect(useWorkflowStore.getState().eventsCursor).toBeNull()
    expect(useWorkflowStore.getState().eventsHasMore).toBe(false)
  })

  it('addToast adds a toast and removeToast clears it', () => {
    useWorkflowStore.getState().addToast('Hello', 'success')
    expect(useWorkflowStore.getState().toasts).toHaveLength(1)
    const id = useWorkflowStore.getState().toasts[0].id
    useWorkflowStore.getState().removeToast(id)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('keeps error toasts on screen longer than success toasts', () => {
    vi.useFakeTimers()
    try {
      useWorkflowStore.setState({ toasts: [] })
      useWorkflowStore.getState().addToast('Saved', 'success')
      useWorkflowStore.getState().addToast('Boom', 'error')
      expect(useWorkflowStore.getState().toasts).toHaveLength(2)
      // The success window (3500ms) elapses — only the error survives.
      vi.advanceTimersByTime(3500)
      const remaining = useWorkflowStore.getState().toasts
      expect(remaining).toHaveLength(1)
      expect(remaining[0].tone).toBe('error')
      // The error window (6000ms total) elapses — it clears too.
      vi.advanceTimersByTime(2500)
      expect(useWorkflowStore.getState().toasts).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists the active tab to localStorage so a refresh can restore it', () => {
    try {
      window.localStorage.removeItem('janusly:activeTab')
      useWorkflowStore.getState().setActiveTab('operations')
      expect(useWorkflowStore.getState().activeTab).toBe('operations')
      expect(window.localStorage.getItem('janusly:activeTab')).toBe('operations')
    } finally {
      window.localStorage.removeItem('janusly:activeTab')
    }
  })

  // bumpPlatformVersion coalesce behavior is covered in the dedicated
  // `useWorkflowStore.bumpPlatformVersion (coalesce)` describe block
  // below — it uses fake timers to assert the 100ms trailing-edge
  // collapse without relying on real wallclock timing inside this case.

  it('stores and clears the latest budget block envelope', () => {
    useWorkflowStore.getState().setBudgetBlocked({
      monthlyUsdSpent: 12,
      monthlyUsdLimit: 10,
      exceededAt: 'org',
      policy: 'block',
    })
    expect(useWorkflowStore.getState().budgetBlocked?.monthlyUsdSpent).toBe(12)
    useWorkflowStore.getState().clearBudgetBlocked()
    expect(useWorkflowStore.getState().budgetBlocked).toBeNull()
  })

  it('resetRun clears runId, run nodes, events, pagination, and stream status', () => {
    useWorkflowStore.setState({
      runId: 'run_1',
      runNodes: [{ nodeId: 'a', status: 'running' }],
      events: [{ id: 'e1', type: 'node.queued' }],
      eventsCursor: '2026-04-29T09:00:00.000Z',
      eventsHasMore: true,
      streamStatus: 'connected',
    })
    useWorkflowStore.getState().resetRun()
    const state = useWorkflowStore.getState()
    expect(state.runId).toBeNull()
    expect(state.runNodes).toEqual([])
    expect(state.events).toEqual([])
    expect(state.eventsCursor).toBeNull()
    expect(state.eventsHasMore).toBe(false)
    expect(state.streamStatus).toBe('idle')
  })

  // Non-canvas tab transitions. The layout dispatcher in App.tsx mounts
  // the workspace contents in the main slot for these (instead of the
  // React Flow canvas), so we pin a handful of representative tabs to
  // guard against accidental enum drift.
  it.each(['operations', 'experiments', 'members', 'credentials'] as const)(
    'setActiveTab accepts the non-canvas tab "%s"',
    (tab) => {
      useWorkflowStore.getState().setActiveTab(tab)
      expect(useWorkflowStore.getState().activeTab).toBe(tab)
    },
  )
})

describe('useWorkflowStore.bumpPlatformVersion (coalesce)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useWorkflowStore.setState({ platformVersion: 0 })
    __resetBumpCoalesceForTests()
  })

  afterEach(() => {
    __resetBumpCoalesceForTests()
    vi.useRealTimers()
  })

  it('collapses multiple bumps within the 100ms window into ONE increment', () => {
    const bump = useWorkflowStore.getState().bumpPlatformVersion
    for (let i = 0; i < 5; i += 1) bump()
    // No increment yet — trailing edge has not fired.
    expect(useWorkflowStore.getState().platformVersion).toBe(0)
    vi.advanceTimersByTime(100)
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
  })

  it('each bump resets the trailing edge — extending the window keeps the count at zero', () => {
    const bump = useWorkflowStore.getState().bumpPlatformVersion
    bump()
    vi.advanceTimersByTime(50)
    bump()
    vi.advanceTimersByTime(50)
    // 100ms wallclock has elapsed but only 50ms since the LAST bump.
    // Trailing edge has NOT fired yet.
    expect(useWorkflowStore.getState().platformVersion).toBe(0)
    vi.advanceTimersByTime(50)
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
  })

  it('a single bump fires exactly one increment after the window elapses', () => {
    useWorkflowStore.getState().bumpPlatformVersion()
    expect(useWorkflowStore.getState().platformVersion).toBe(0)
    vi.advanceTimersByTime(100)
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
    // No follow-up tick should fire — the timer is one-shot per bump cluster.
    vi.advanceTimersByTime(1000)
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
  })
})

describe('useWorkflowStore semantic workflow signals', () => {
  // The change reducers no-op until React Flow's ops register (CanvasWorkspace
  // does it at import time in production) — stub the two we exercise here.
  beforeEach(() => {
    registerFlowOps({
      applyNodeChanges: (changes, nodes) =>
        nodes.filter((node) => !changes.some((change) => change.type === 'remove' && 'id' in change && change.id === node.id)),
      applyEdgeChanges: (_changes, edges) => edges,
      addEdge: (_connection, edges) => edges,
    } as never)
  })

  it('starts clean and turns dirty on semantic mutations', () => {
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)
    useWorkflowStore.getState().addNode('http')
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('setWorkflowName / updateSelectedNodeConfig / updateEdgeCondition mark dirty', () => {
    useWorkflowStore.getState().setWorkflowName('renamed')
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)

    useWorkflowStore.setState({ workflowDirty: false })
    useWorkflowStore.getState().addNode('http')
    useWorkflowStore.setState({ workflowDirty: false, selectedNodeId: useWorkflowStore.getState().nodes[0].id })
    useWorkflowStore.getState().updateSelectedNodeConfig({ url: 'https://changed.example' })
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('hydrateWorkflow and newWorkflow reset the flag', () => {
    useWorkflowStore.getState().addNode('http')
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
    useWorkflowStore.getState().hydrateWorkflow({ id: 'wf_x', name: 'X', nodes: [], edges: [] })
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)

    useWorkflowStore.getState().addNode('http')
    useWorkflowStore.getState().newWorkflow()
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)
  })

  it('markWorkflowSaved clears the flag; markWorkflowDirty forces it on', () => {
    useWorkflowStore.getState().addNode('http')
    useWorkflowStore.getState().markWorkflowSaved()
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)

    useWorkflowStore.getState().markWorkflowDirty()
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('node position changes do NOT mark dirty (layout is never serialized), removals do', () => {
    useWorkflowStore.getState().addNode('http')
    const nodeId = useWorkflowStore.getState().nodes[0].id
    useWorkflowStore.setState({ workflowDirty: false })

    useWorkflowStore.getState().onNodesChange([
      { id: nodeId, type: 'position', position: { x: 500, y: 500 } },
    ])
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)

    useWorkflowStore.getState().onNodesChange([{ id: nodeId, type: 'remove' }])
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('increments workflowRevision only for serialized graph changes', () => {
    expect(useWorkflowStore.getState().workflowRevision).toBe(0)
    useWorkflowStore.getState().addNode('http')
    const nodeId = useWorkflowStore.getState().nodes[0].id
    expect(useWorkflowStore.getState().workflowRevision).toBe(1)

    useWorkflowStore.getState().onNodesChange([
      { id: nodeId, type: 'position', position: { x: 300, y: 200 } },
    ])
    expect(useWorkflowStore.getState().workflowRevision).toBe(1)

    useWorkflowStore.getState().onNodesChange([{ id: nodeId, type: 'remove' }])
    expect(useWorkflowStore.getState().workflowRevision).toBe(2)
  })
})
