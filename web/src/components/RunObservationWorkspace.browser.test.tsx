import { act, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import type { RunMap } from '../run-map'
import { useWorkflowStore } from '../store'
import { leadingAccents } from '../test/leading-accent'
import type { RunNode, RunSummary } from '../types'
import { RunObservationWorkspace } from './CanvasWorkspace'
import { ConfirmProvider } from './ConfirmDialog'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api), downloadFromApi: vi.fn() }
})

const run: RunSummary = {
  id: 'run-map-browser',
  status: 'running',
  inputJson: {
    workflow: {
      id: 'wf', name: 'Billing', dslVersion: '1.0',
      nodes: [
        { id: 'fetch', type: 'http', label: 'Fetch invoice', config: {} },
        { id: 'gate', type: 'tool', label: 'Charge card', config: {} },
      ],
      edges: [{ from: 'fetch', to: 'gate' }],
      ui: { positions: { fetch: { x: 0, y: 0 }, gate: { x: 0, y: 260 } } },
    },
  },
}

const runNodes: RunNode[] = [
  { nodeId: 'fetch', status: 'running', attempts: 2, startedAt: '2026-11-07T10:00:00Z' },
  waitingGate({}),
]

const map: RunMap = {
  run: { id: run.id, status: 'running', workflowVersionId: 'v1', parentRunId: null },
  nodes: [
    { nodeId: 'fetch', type: 'http', status: 'running', attempts: 2, startedAt: '2026-11-07T10:00:00Z', finishedAt: null,
      elapsedMs: 1_260_000, costUsd: 0.02, tokens: 3_000, stuck: true, needsYou: false, waitingKind: null, childRunId: null },
    { nodeId: 'gate', type: 'tool', status: 'waiting', attempts: 1, startedAt: '2026-11-07T10:00:00Z', finishedAt: null,
      elapsedMs: 1_000, costUsd: 0, tokens: 0, stuck: false, needsYou: true, waitingKind: 'tool_approval', childRunId: null },
  ],
  lanes: [],
  totals: { costUsd: 0.02, tokens: 3_000 },
}

function makeExecution(onApproveNode = vi.fn(async () => undefined)) {
  return { onApproveNode, onSubmitHumanForm: vi.fn(), onOpenRun: vi.fn() }
}
type Execution = ReturnType<typeof makeExecution>

function waitingGate(waiting: Record<string, unknown>): RunNode {
  return {
    nodeId: 'gate', status: 'waiting', startedAt: '2026-11-07T10:00:00Z',
    stateJson: { waiting: { kind: 'tool_approval', approvalId: 'ta-1', tool: 'stripe.charge', paramsDigest: 'digest-1', params: { amount: 5 }, ...waiting } },
  }
}

function view(execution: Execution, nodes: RunNode[] = runNodes) {
  return (
    <ConfirmProvider>
      <div style={{ width: 1100, height: 760, display: 'flex' }}>
        <RunObservationWorkspace run={run} runNodes={nodes} panel={null} permissions={['runs.read', 'runs.start']} execution={execution} />
      </div>
    </ConfirmProvider>
  )
}

function mount() {
  const execution = makeExecution()
  return { ...render(view(execution)), execution }
}

beforeEach(() => {
  useWorkflowStore.getState().setAuth({ session: null, user: null, userId: 'viewer-a', orgId: 'org-a' })
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue(map)
})

describe('run map canvas (browser mode)', () => {
  it('removes prior-workspace totals and decisions when the next workspace refuses the run', async () => {
    mount()
    expect(await screen.findByTestId('run-map-totals')).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Approve Charge card' })).toBeVisible()
    vi.mocked(api).mockRejectedValue(new Error('run not found'))
    act(() => {
      useWorkflowStore.getState().setAuth({ session: null, user: null, userId: 'viewer-a', orgId: 'org-b' })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('run-map-totals')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Approve Charge card' })).not.toBeInTheDocument()
    })
  })

  it('shows totals, a stuck step on a dashed full border and no leading bar', async () => {
    const { container } = mount()
    const totals = await screen.findByTestId('run-map-totals')
    expect(within(totals).getByText('$0.02')).toBeVisible()
    expect(within(totals).getByText('3K')).toBeVisible()
    const stuck = (await screen.findByTestId('workflow-node-stuck')).closest('.workflow-node') as HTMLElement
    const style = getComputedStyle(stuck)
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      expect(style.getPropertyValue(`border-${side.toLowerCase()}-style`)).toBe('dashed')
      expect(style.getPropertyValue(`border-${side.toLowerCase()}-width`)).toBe(style.borderTopWidth)
    }
    expect(within(stuck).getByText('Attempt 2')).toBeVisible()
    expect(within(stuck).getByTestId('workflow-node-elapsed')).toHaveTextContent(/^21m/)
    const needsYou = screen.getByTestId('workflow-node-needs-you').closest('.workflow-node') as HTMLElement
    expect(getComputedStyle(needsYou).outlineStyle).toBe('solid')
    expect(leadingAccents(container)).toEqual([])
    expect(screen.getByRole('group', { name: /Charge card.*Needs you/ })).toBeInTheDocument()
  })

  it('approves the tool call the dialog showed and refreshes the map', async () => {
    const { execution } = mount()
    const approve = await screen.findByRole('button', { name: 'Approve Charge card' })
    approve.focus()
    expect(approve).toHaveFocus()
    expect((approve.closest('.react-flow') as HTMLElement).scrollTop).toBe(0)
    approve.click()
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve Charge card' })
    expect(within(dialog).getByTestId('tool-approval-tool-gate')).toHaveTextContent('stripe.charge')
    expect(await within(dialog).findByTestId('tool-approval-params-gate')).toHaveTextContent('"amount": 5')
    expect(execution.onApproveNode).not.toHaveBeenCalled()
    within(dialog).getByTestId('confirm-dialog-confirm').click()
    await waitFor(() => expect(execution.onApproveNode).toHaveBeenCalledWith('gate', { approvalId: 'ta-1', paramsDigest: 'digest-1', decision: 'approve' }))
    await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === `/v1/runs/${run.id}/map`).length).toBeGreaterThan(1))
  })

  it('refuses a decision whose request changed while the dialog was open and shows it again', async () => {
    const { execution, rerender } = mount()
    ;(await screen.findByRole('button', { name: 'Deny Charge card' })).click()
    const dialog = await screen.findByRole('alertdialog', { name: 'Deny Charge card' })
    rerender(view(execution, [runNodes[0], waitingGate({ approvalId: 'ta-2', paramsDigest: 'digest-2', params: { amount: 500 } })]))
    within(dialog).getByTestId('confirm-dialog-confirm').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Deny Charge card' })).toHaveTextContent('This request changed'))
    const again = screen.getByRole('alertdialog', { name: 'Deny Charge card' })
    // The second click of a double click lands on the reopened dialog and must not decide.
    within(again).getByTestId('confirm-dialog-confirm').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    expect(await within(again).findByTestId('tool-approval-params-gate')).toHaveTextContent('"amount": 500')
    expect(execution.onApproveNode).not.toHaveBeenCalled()
    within(again).getByTestId('confirm-dialog-confirm').click()
    await waitFor(() => expect(execution.onApproveNode).toHaveBeenCalledWith('gate', { approvalId: 'ta-2', paramsDigest: 'digest-2', decision: 'deny' }))
  })

  it('decides nothing once the step stopped waiting', async () => {
    const { execution, rerender } = mount()
    ;(await screen.findByRole('button', { name: 'Approve Charge card' })).click()
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve Charge card' })
    rerender(view(execution, [runNodes[0], { nodeId: 'gate', status: 'succeeded', startedAt: '2026-11-07T10:00:00Z' }]))
    within(dialog).getByTestId('confirm-dialog-confirm').click()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(execution.onApproveNode).not.toHaveBeenCalled()
  })
})

describe('run map form (browser mode)', () => {
  const formRun: RunSummary = {
    ...run,
    inputJson: {
      workflow: {
        id: 'wf', name: 'Intake', dslVersion: '1.0',
        nodes: [{ id: 'ask', type: 'human_form', label: 'Ask requester', config: {} }],
        edges: [],
        ui: { positions: { ask: { x: 0, y: 0 } } },
      },
    },
  }
  const formMap: RunMap = {
    ...map,
    nodes: [{ nodeId: 'ask', type: 'human_form', status: 'waiting', attempts: 1, startedAt: '2026-11-07T10:00:00Z', finishedAt: null,
      elapsedMs: 1_000, costUsd: 0, tokens: 0, stuck: false, needsYou: true, waitingKind: 'human_form', childRunId: null }],
  }
  const waiting = (resumeToken: string, field: string): RunNode[] => [{
    nodeId: 'ask', status: 'waiting', startedAt: '2026-11-07T10:00:00Z',
    stateJson: { waiting: { kind: 'human_form', resumeToken, schema: { type: 'object', properties: { [field]: { type: 'string' } } } } },
  }]
  const settled: RunNode[] = [{ nodeId: 'ask', status: 'succeeded', startedAt: '2026-11-07T10:00:00Z' }]

  function mountForm(nodes: RunNode[]) {
    const execution = { onApproveNode: vi.fn(), onSubmitHumanForm: vi.fn(async () => undefined), onOpenRun: vi.fn() }
    const element = (current: RunNode[]) => (
      <div style={{ width: 1100, height: 760, display: 'flex' }}>
        <RunObservationWorkspace run={formRun} runNodes={current} panel={null} permissions={['runs.read', 'runs.start']} execution={execution} />
      </div>
    )
    const view = render(element(nodes))
    return { execution, update: (next: RunNode[]) => view.rerender(element(next)) }
  }

  beforeEach(() => {
    vi.mocked(api).mockResolvedValue(formMap)
  })

  it('closes the form when its resume token changes, so new input goes with the new token', async () => {
    const { execution, update } = mountForm(waiting('tok-1', 'reason'))
    ;(await screen.findByRole('button', { name: 'Fill in the form for Ask requester' })).click()
    expect(await screen.findByLabelText(/reason/i)).toBeInTheDocument()

    update(waiting('tok-2', 'amount'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    ;(await screen.findByRole('button', { name: 'Fill in the form for Ask requester' })).click()
    const amount = await screen.findByLabelText(/amount/i)
    expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(amount, '12')
      amount.dispatchEvent(new Event('input', { bubbles: true }))
    })
    screen.getByRole('button', { name: /Submit form/i }).click()
    await waitFor(() => expect(execution.onSubmitHumanForm).toHaveBeenCalledWith('ask', { amount: '12' }, 'tok-2'))
  })

  it('does not reopen a form by itself after its step stopped waiting', async () => {
    const { update } = mountForm(waiting('tok-1', 'reason'))
    ;(await screen.findByRole('button', { name: 'Fill in the form for Ask requester' })).click()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    update(settled)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    update(waiting('tok-3', 'reason'))
    expect(await screen.findByRole('button', { name: 'Fill in the form for Ask requester' })).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
