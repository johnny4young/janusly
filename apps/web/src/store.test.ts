import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBumpCoalesceForTests, registerFlowOps, registerNodePlacementResolver, useWorkflowStore } from './store'

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
      recoveryIntroDismissedThisSession: false,
    },
    true,
  )
})

describe('useWorkflowStore', () => {
  it('initializes the translated starter name only while the boot sentinel is empty', () => {
    useWorkflowStore.setState({ currentWorkflowName: '', workflowDirty: false })
    useWorkflowStore.getState().initializeWorkflowName('Flujo de ejemplo')
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowName: 'Flujo de ejemplo',
      workflowDirty: false,
    })

    useWorkflowStore.getState().initializeWorkflowName('Sample workflow')
    expect(useWorkflowStore.getState().currentWorkflowName).toBe('Flujo de ejemplo')
  })

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

  it('seeds a representative request, condition, and approval workflow', () => {
    expect(initialState.nodes.map(node => node.data.type)).toEqual(['http', 'condition', 'approval'])
    expect(initialState.nodes.find(node => node.id === 'check')?.data.config).toEqual({
      expression: 'context.fetch.output.statusCode === 200',
    })
    expect(initialState.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['fetch', 'check'],
      ['check', 'approve'],
    ])
    expect(initialState.edges.find(edge => edge.source === 'check')?.data?.condition)
      .toBe('context.check.output.result === true')
  })

  it('hydrateWorkflow loads nodes/edges and resets selection and run state', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf_1',
      name: 'Pipeline',
      nodes: [
        { id: 'a', type: 'noop', label: 'Start here', config: {} },
        { id: 'b', type: 'http', config: { url: 'https://example.com' } },
      ],
      edges: [{ from: 'a', to: 'b', condition: 'true' }],
      ui: { positions: { a: { x: 25, y: 40 }, b: { x: 280, y: 120 } } },
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
    expect(state.nodes[0].data.label).toBe('Start here')
    expect(state.nodes[1].data.label).toBe('')
    expect(state.nodes.map(node => node.position)).toEqual([{ x: 25, y: 40 }, { x: 280, y: 120 }])
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
      ui: { positions: { n1: { x: 80, y: 80 } } },
    })
  })

  it('round-trips the opt-in strict template policy and resets it for a new workflow', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf-strict',
      templatePolicy: 'strict',
      nodes: [{ id: 'n1', type: 'noop', config: {} }],
      edges: [],
    })

    expect(useWorkflowStore.getState().currentWorkflowTemplatePolicy).toBe('strict')
    expect(useWorkflowStore.getState().getWorkflowJson()).toMatchObject({ templatePolicy: 'strict' })

    useWorkflowStore.getState().newWorkflow()
    expect(useWorkflowStore.getState().currentWorkflowTemplatePolicy).toBeUndefined()
    expect(useWorkflowStore.getState().getWorkflowJson()).not.toHaveProperty('templatePolicy')
  })

  it('serializes trimmed custom labels and editor positions', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf-layout',
      nodes: [{ id: 'named', type: 'noop', label: '  Review invoice  ', config: {} }],
      edges: [],
      ui: { positions: { named: { x: 420, y: -15 } } },
    })

    expect(useWorkflowStore.getState().getWorkflowJson()).toMatchObject({
      nodes: [{ id: 'named', type: 'noop', label: 'Review invoice', config: {} }],
      ui: { positions: { named: { x: 420, y: -15 } } },
    })
  })

  it('places new nodes through the lazy canvas resolver when available', () => {
    const unregister = registerNodePlacementResolver(() => ({ x: 640, y: 360 }))
    useWorkflowStore.getState().addNode('noop')
    unregister()

    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 640, y: 360 })
  })

  it('prefers an explicit drop position over the viewport placement resolver', () => {
    const unregister = registerNodePlacementResolver(() => ({ x: 640, y: 360 }))
    useWorkflowStore.getState().addNode('noop', { x: 75, y: 95 })
    unregister()

    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 75, y: 95 })
  })

  it('duplicates a step beside the source with independent config and selection ownership', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{ id: 'source', type: 'http', label: 'Fetch invoice', config: { url: 'https://example.com', headers: { accept: 'json' } } }],
      edges: [],
      ui: { positions: { source: { x: 100, y: 200 } } },
    })
    const revision = useWorkflowStore.getState().workflowRevision

    useWorkflowStore.getState().duplicateNode('source')

    const state = useWorkflowStore.getState()
    expect(state.nodes).toHaveLength(2)
    expect(state.nodes[1]).toMatchObject({
      position: { x: 132, y: 232 },
      data: { type: 'http', label: 'Fetch invoice', config: { url: 'https://example.com', headers: { accept: 'json' } } },
    })
    expect(state.nodes[1].id).not.toBe('source')
    expect(state.nodes[1].data.config).not.toBe(state.nodes[0].data.config)
    expect(state.selectedNodeId).toBe(state.nodes[1].id)
    expect(state.workflowDirty).toBe(true)
    expect(state.workflowRevision).toBe(revision + 1)
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

  it('preserves a custom step name when its kind changes', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{ id: 'named', type: 'noop', label: 'Human review', config: {} }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('named')
    useWorkflowStore.getState().updateSelectedNodeType('approval')
    expect(useWorkflowStore.getState().nodes[0].data.label).toBe('Human review')
  })

  it('updates custom names and typed workflow I/O as semantic edits', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{ id: 'named', type: 'noop', config: {} }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('named')
    const revision = useWorkflowStore.getState().workflowRevision

    useWorkflowStore.getState().updateNodeLabel('named', 'Review invoice')
    useWorkflowStore.getState().updateWorkflowInputs({
      type: 'object',
      properties: { invoiceId: { type: 'string' } },
      required: ['invoiceId'],
    })
    useWorkflowStore.getState().updateWorkflowOutputs({ result: '{{context.named.output}}' })

    const state = useWorkflowStore.getState()
    expect(state.nodes[0].data.label).toBe('Review invoice')
    expect(state.currentWorkflowInputs?.properties).toHaveProperty('invoiceId')
    expect(state.currentWorkflowOutputs).toEqual({ result: '{{context.named.output}}' })
    expect(state.workflowDirty).toBe(true)
    expect(state.workflowRevision).toBe(revision + 3)
  })

  it('updates the explicit label target even when store selection has moved', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [
        { id: 'node-a', type: 'noop', config: {} },
        { id: 'node-b', type: 'noop', config: {} },
      ],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('node-b')

    useWorkflowStore.getState().updateNodeLabel('node-a', 'Name node A')

    expect(useWorkflowStore.getState().nodes.map(node => node.data.label)).toEqual(['Name node A', ''])
  })

  it('preserves generic execution controls and drops source-specific config on a type change', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{
        id: 'http-call',
        type: 'http',
        config: {
          url: 'https://example.com',
          method: 'POST',
          maxResponseBytes: 2048,
          retry: { maxAttempts: 4, backoff: 'exponential' },
          timeoutMs: 45_000,
        },
      }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('http-call')
    const previousRetry = useWorkflowStore.getState().nodes[0].data.config.retry

    useWorkflowStore.getState().updateSelectedNodeType('ai')

    const config = useWorkflowStore.getState().nodes[0].data.config
    expect(config).toEqual({
      prompt: 'Summarize the latest workflow result and suggest the next action.',
      retry: { maxAttempts: 4, backoff: 'exponential' },
      timeoutMs: 45_000,
    })
    expect(config.retry).not.toBe(previousRetry)
    expect(config).not.toHaveProperty('url')
    expect(config).not.toHaveProperty('method')
    expect(config).not.toHaveProperty('maxResponseBytes')
  })

  it('drops a source timeout that exceeds the MCP target limit', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{ id: 'long-call', type: 'http', config: { url: 'https://example.com', timeoutMs: 120_001 } }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('long-call')

    useWorkflowStore.getState().updateSelectedNodeType('mcp_tool')

    expect(useWorkflowStore.getState().nodes[0].data.config).toEqual({ connectionAlias: '', toolName: '', input: {} })
  })

  it('carries only valid runtime retry controls into the target kind', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{
        id: 'invalid-retry',
        type: 'http',
        config: {
          url: 'https://example.com',
          retry: {
            maxAttempts: 'forever',
            delayMs: 0,
            maxDelayMs: Number.POSITIVE_INFINITY,
            backoff: 'random',
            jitter: true,
            retryOn: ['5xx'],
            ignoreOn: ['4xx', 401],
            sourceOnly: 'discard me',
          },
          timeoutMs: 1.5,
        },
      }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('invalid-retry')

    useWorkflowStore.getState().updateSelectedNodeType('ai')

    expect(useWorkflowStore.getState().nodes[0].data.config.retry).toEqual({
      delayMs: 0,
      jitter: true,
      retryOn: ['5xx'],
    })
    expect(useWorkflowStore.getState().nodes[0].data.config).not.toHaveProperty('timeoutMs')
  })

  it('does not dirty or increment the revision for a same-kind no-op', () => {
    useWorkflowStore.getState().hydrateWorkflow({
      id: 'wf',
      nodes: [{ id: 'same', type: 'noop', config: {} }],
      edges: [],
    })
    useWorkflowStore.getState().selectNode('same')
    const before = useWorkflowStore.getState()

    useWorkflowStore.getState().updateSelectedNodeType('noop')

    const after = useWorkflowStore.getState()
    expect(after.workflowRevision).toBe(before.workflowRevision)
    expect(after.workflowDirty).toBe(before.workflowDirty)
    expect(after.nodes).toBe(before.nodes)
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
    const generation = useWorkflowStore.getState().runTransitionGeneration
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
    expect(state.runTransitionGeneration).toBe(generation + 1)
  })

  it('invalidates run ownership atomically when the auth owner changes', () => {
    useWorkflowStore.setState({
      userId: 'user-a',
      orgId: 'org-a',
      runId: 'run-a',
      runDetail: { id: 'run-a', status: 'running' },
      runNodes: [{ nodeId: 'a', status: 'running' }],
      events: [{ id: 'e1', type: 'node.running' }],
    })
    const generation = useWorkflowStore.getState().runTransitionGeneration

    useWorkflowStore.getState().setAuth({
      session: null,
      user: null,
      userId: 'user-b',
      orgId: 'org-b',
    })

    const state = useWorkflowStore.getState()
    expect(state.runTransitionGeneration).toBe(generation + 1)
    expect(state.runId).toBeNull()
    expect(state.runDetail).toBeNull()
    expect(state.runNodes).toEqual([])
    expect(state.events).toEqual([])
  })

  it('resets the session-only recovery intro dismissal across auth owners', () => {
    useWorkflowStore.setState({
      userId: 'user-a',
      orgId: 'org-a',
      recoveryIntroDismissedThisSession: true,
    })

    useWorkflowStore.getState().setAuth({
      session: null,
      user: null,
      userId: 'user-a',
      orgId: 'org-b',
    })

    expect(useWorkflowStore.getState().recoveryIntroDismissedThisSession).toBe(false)
  })

  it('preserves the active run when only the auth session refreshes', () => {
    useWorkflowStore.setState({ userId: 'user-a', orgId: 'org-a', runId: 'run-a' })
    const generation = useWorkflowStore.getState().runTransitionGeneration

    useWorkflowStore.getState().setAuth({
      session: null,
      user: null,
      userId: 'user-a',
      orgId: 'org-a',
    })

    expect(useWorkflowStore.getState().runId).toBe('run-a')
    expect(useWorkflowStore.getState().runTransitionGeneration).toBe(generation)
  })

  it('switches active runs atomically and clears the prior projection', () => {
    useWorkflowStore.setState({
      runId: 'run-a',
      runDetail: { id: 'run-a', status: 'running' },
      runNodes: [{ nodeId: 'a', status: 'running' }],
      events: [{ id: 'e1', type: 'node.running' }],
    })
    const generation = useWorkflowStore.getState().runTransitionGeneration

    useWorkflowStore.getState().setRunId('run-b')

    const state = useWorkflowStore.getState()
    expect(state.runId).toBe('run-b')
    expect(state.runTransitionGeneration).toBe(generation + 1)
    expect(state.runDetail).toBeNull()
    expect(state.runNodes).toEqual([])
    expect(state.events).toEqual([])
  })

  it('invalidates run ownership when authoring replaces the workflow', () => {
    const generation = useWorkflowStore.getState().runTransitionGeneration
    useWorkflowStore.getState().hydrateWorkflow({ id: 'wf-a', nodes: [], edges: [] })
    expect(useWorkflowStore.getState().runTransitionGeneration).toBe(generation + 1)

    useWorkflowStore.getState().newWorkflow()
    expect(useWorkflowStore.getState().runTransitionGeneration).toBe(generation + 2)
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
      applyNodeChanges: (changes, nodes) => nodes
        .filter((node) => !changes.some((change) => change.type === 'remove' && 'id' in change && change.id === node.id))
        .map((node) => {
          const position = changes.find(change => change.type === 'position' && change.id === node.id)
          return position && position.type === 'position' && position.position
            ? { ...node, position: position.position }
            : node
        }),
      applyEdgeChanges: (_changes, edges) => edges,
      addEdge: (_connection, edges) => edges,
    })
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

  it('marks completed position changes dirty, ignores in-progress drag events, and marks removals semantic', () => {
    useWorkflowStore.getState().addNode('http')
    const nodeId = useWorkflowStore.getState().nodes[0].id
    useWorkflowStore.setState({ workflowDirty: false })

    useWorkflowStore.getState().onNodesChange([
      { id: nodeId, type: 'position', position: { x: 400, y: 400 }, dragging: true },
    ])
    expect(useWorkflowStore.getState().workflowDirty).toBe(false)

    useWorkflowStore.getState().onNodesChange([
      { id: nodeId, type: 'position', position: { x: 500, y: 500 }, dragging: false },
    ])
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
    expect(useWorkflowStore.getState().getWorkflowJson().ui?.positions?.[nodeId]).toEqual({ x: 500, y: 500 })

    useWorkflowStore.setState({ workflowDirty: false })
    useWorkflowStore.getState().onNodesChange([{ id: nodeId, type: 'remove' }])
    expect(useWorkflowStore.getState().workflowDirty).toBe(true)
  })

  it('increments workflowRevision only for semantic graph changes', () => {
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
