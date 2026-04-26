import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkflowStore } from './store'

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
      currentWorkflowName: 'UI Test Workflow',
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      runId: null,
      runNodes: [],
      events: [],
      activeTab: 'crew',
      streamStatus: 'idle',
      toasts: [],
      platformVersion: 0,
    },
    true,
  )
})

describe('useWorkflowStore', () => {
  it('addNode appends a node with its preset config and uppercase label', () => {
    useWorkflowStore.getState().addNode('http')
    const { nodes } = useWorkflowStore.getState()
    expect(nodes).toHaveLength(1)
    expect(nodes[0].data.type).toBe('http')
    expect(nodes[0].data.label).toBe('HTTP')
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
    expect(state.nodes[0].data.label).toBe('APPROVAL')
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

  it('addToast adds a toast and removeToast clears it', () => {
    useWorkflowStore.getState().addToast('Hello', 'success')
    expect(useWorkflowStore.getState().toasts).toHaveLength(1)
    const id = useWorkflowStore.getState().toasts[0].id
    useWorkflowStore.getState().removeToast(id)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('bumpPlatformVersion increments by one', () => {
    expect(useWorkflowStore.getState().platformVersion).toBe(0)
    useWorkflowStore.getState().bumpPlatformVersion()
    useWorkflowStore.getState().bumpPlatformVersion()
    expect(useWorkflowStore.getState().platformVersion).toBe(2)
  })

  it('resetRun clears runId, run nodes, events, and stream status', () => {
    useWorkflowStore.setState({
      runId: 'run_1',
      runNodes: [{ nodeId: 'a', status: 'running' }],
      events: [{ id: 'e1', type: 'node.queued' }],
      streamStatus: 'connected',
    })
    useWorkflowStore.getState().resetRun()
    const state = useWorkflowStore.getState()
    expect(state.runId).toBeNull()
    expect(state.runNodes).toEqual([])
    expect(state.events).toEqual([])
    expect(state.streamStatus).toBe('idle')
  })
})
