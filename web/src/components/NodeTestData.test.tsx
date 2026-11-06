import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useTestData } from '../lib/test-data'
import { useWorkflowStore } from '../store'
import type { RunNode, WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { NodeTestData } from './NodeTestData'
import { WorkflowStepNode } from './WorkflowStepNode'

vi.mock('../api', () => ({ api: vi.fn() }))

const node = (id: string, type = 'transform'): WorkflowGraphNode =>
  ({ id, position: { x: 0, y: 0 }, data: { type, config: {}, label: id } }) as WorkflowGraphNode
const nodes = [node('fetch', 'http'), node('shape'), node('gate', 'approval'), node('other')]
const edges: WorkflowGraphEdge[] = [
  { id: 'e1', source: 'fetch', target: 'shape' },
  { id: 'e2', source: 'shape', target: 'gate' },
]
const runNodes: RunNode[] = [
  { nodeId: 'fetch', status: 'succeeded', stateJson: { output: { orderId: 'ord_481' } } },
  { nodeId: 'shape', status: 'succeeded', stateJson: { output: { items: 3 } } },
  { nodeId: 'other', status: 'succeeded', stateJson: { output: { unrelated: true } } },
] as RunNode[]

function renderFor(selected: WorkflowGraphNode, readOnly = false) {
  return render(<NodeTestData node={selected} nodes={nodes} edges={edges} readOnly={readOnly} />)
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useTestData.setState({ scope: '', pins: {} })
  localStorage.removeItem('janusly:activeOrg')
  useWorkflowStore.setState({
    currentWorkflowId: 'wf-1',
    runId: 'run-12345678',
    runDetail: { id: 'run-12345678', status: 'succeeded', inputJson: { workflow: { id: 'wf-1' }, input: { tag: 'a' } } },
    runNodes,
    toasts: [],
  })
})

describe('<NodeTestData />', () => {
  it('shows the data a step reads from its ancestors and pins its own output', () => {
    renderFor(nodes[1])
    expect(screen.getByTestId('test-data-row-fetch')).toHaveTextContent('ord_481')
    expect(screen.getByTestId('test-data-row-shape')).toHaveTextContent('"items": 3')
    expect(screen.queryByTestId('test-data-row-other')).toBeNull()
    expect(screen.getByTestId('test-data-source-shape')).toHaveTextContent('Last run run-1234')

    fireEvent.click(screen.getByTestId('test-data-pin'))
    expect(useTestData.getState().pins).toMatchObject({ shape: { kind: 'pinned', sourceRunId: 'run-12345678' } })
    expect(screen.getByTestId('test-data-source-shape')).toHaveTextContent('Pinned · run run-1234')
    expect(screen.queryByTestId('test-data-pin')).toBeNull()

    fireEvent.click(screen.getByTestId('test-data-clear'))
    expect(useTestData.getState().pins).toEqual({})
  })

  it('mocks an output and rejects invalid JSON', () => {
    renderFor(nodes[0])
    fireEvent.click(screen.getByTestId('test-data-mock'))
    const input = screen.getByTestId('test-data-mock-input')
    fireEvent.change(input, { target: { value: '{bad' } })
    fireEvent.click(screen.getByTestId('test-data-mock-save'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(useTestData.getState().pins).toEqual({})

    fireEvent.change(input, { target: { value: '{"ok":true}' } })
    fireEvent.click(screen.getByTestId('test-data-mock-save'))
    expect(useTestData.getState().pins.fetch).toEqual({ kind: 'mocked', output: { ok: true } })
    expect(screen.getByTestId('test-data-source-fetch')).toHaveTextContent('Mocked')

    fireEvent.click(screen.getByTestId('test-data-mock'))
    fireEvent.click(screen.getByTestId('test-data-mock-cancel'))
    expect(screen.queryByTestId('test-data-mock-input')).toBeNull()
  })

  it('never offers a stand-in for an approval, and nothing when read-only', () => {
    const { unmount } = renderFor(nodes[2])
    expect(screen.queryByTestId('test-data-pin')).toBeNull()
    expect(screen.queryByTestId('test-data-mock')).toBeNull()
    expect(screen.getByTestId('test-data-run-step')).toBeInTheDocument()
    unmount()

    renderFor(nodes[1], true)
    expect(screen.queryByTestId('test-data-mock')).toBeNull()
    expect(screen.queryByTestId('test-data-run-step')).toBeNull()
    expect(screen.queryByTestId('test-data-run-draft')).toBeNull()
  })

  it('does not offer last-run data from another workflow', () => {
    useWorkflowStore.setState({ runDetail: { id: 'run-12345678', status: 'succeeded', inputJson: { workflow: { id: 'wf-2' } } } })
    renderFor(nodes[1])
    expect(screen.queryByTestId('test-data-row-shape')).toBeNull()
    expect(screen.queryByTestId('test-data-pin')).toBeNull()
  })

  it('offers last-run data only from a production run', () => {
    useWorkflowStore.setState({ runDetail: { id: 'run-12345678', status: 'succeeded', replayMode: 'validation', inputJson: { workflow: { id: 'wf-1' } } } })
    renderFor(nodes[1])
    expect(screen.queryByTestId('test-data-row-fetch')).toBeNull()
    expect(screen.queryByTestId('test-data-row-shape')).toBeNull()
    expect(screen.queryByTestId('test-data-pin')).toBeNull()
  })

  it('keeps Clear for a stale stand-in and never sends it', async () => {
    useWorkflowStore.setState({ getWorkflowJson: () => ({ id: 'wf-1', name: 'W', nodes: [{ id: 'gate', type: 'approval', config: {} }], edges: [] }) } as never)
    useTestData.getState().setDatum('wf-1', 'gate', { kind: 'mocked', output: 1 })
    vi.mocked(api).mockResolvedValue({ runId: 'run-test-0002' })
    renderFor(nodes[2])
    expect(screen.queryByTestId('test-data-mock')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('test-data-run-draft')) })
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).pins).toEqual({})
    fireEvent.click(screen.getByTestId('test-data-clear'))
    expect(useTestData.getState().pins).toEqual({})
  })

  it('keeps stand-ins to the workspace that set them', () => {
    useTestData.getState().setDatum('wf-1', 'fetch', { kind: 'mocked', output: 1 })
    localStorage.setItem('janusly:activeOrg', 'other-org')
    renderFor(nodes[0])
    expect(screen.getByTestId('test-data-source-fetch')).toHaveTextContent('Last run')
    expect(screen.queryByTestId('test-data-clear')).toBeNull()
  })

  it('starts a step test with the stand-ins and the last input', async () => {
    useWorkflowStore.setState({ getWorkflowJson: () => ({ id: 'wf-1', name: 'W', nodes: [{ id: 'fetch', type: 'http', config: {} }, { id: 'shape', type: 'transform', config: {} }], edges: [] }) } as never)
    useTestData.getState().setDatum('wf-1', 'fetch', { kind: 'pinned', sourceRunId: 'run-12345678', output: {} })
    useTestData.getState().setDatum('wf-1', 'gone', { kind: 'mocked', output: 1 })
    vi.mocked(api).mockResolvedValue({ runId: 'run-test-0001' })
    renderFor(nodes[1])
    await act(async () => { fireEvent.click(screen.getByTestId('test-data-run-step')) })
    const [path, init] = vi.mocked(api).mock.calls[0]
    expect(path).toBe('/runs/draft-test')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      pins: { fetch: { sourceRunId: 'run-12345678' } }, stepNodeId: 'shape', input: { tag: 'a' },
    })
    expect(JSON.parse(String(init?.body)).pins.gone).toBeUndefined()
    await waitFor(() => expect(useWorkflowStore.getState().runId).toBe('run-test-0001'))

    vi.mocked(api).mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId('test-data-run-draft')) })
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).stepNodeId).toBeUndefined()
  })

  it('marks a pinned or mocked step on the canvas', () => {
    useTestData.getState().setDatum('wf-1', 'fetch', { kind: 'mocked', output: 1 })
    const props = { id: 'fetch', data: nodes[0].data, selected: false } as unknown as NodeProps<WorkflowGraphNode>
    const { rerender } = render(<ReactFlowProvider><WorkflowStepNode {...props} /></ReactFlowProvider>)
    expect(screen.getByTestId('workflow-node-stand-in')).toHaveTextContent('Mocked')
    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf-other' }) })
    rerender(<ReactFlowProvider><WorkflowStepNode {...props} /></ReactFlowProvider>)
    expect(screen.queryByTestId('workflow-node-stand-in')).toBeNull()
  })
})
