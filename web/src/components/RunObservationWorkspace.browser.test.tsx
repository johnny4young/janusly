import { act, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import type { RunMap } from '../run-map'
import { useWorkflowStore } from '../store'
import { leadingAccents } from '../test/leading-accent'
import type { RunNode, RunSummary } from '../types'
import { RunObservationWorkspace } from './CanvasWorkspace'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
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
  {
    nodeId: 'gate', status: 'waiting', startedAt: '2026-11-07T10:00:00Z',
    stateJson: { waiting: { kind: 'tool_approval', approvalId: 'ta-1', tool: 'stripe.charge', paramsDigest: 'digest-1', params: { amount: 5 } } },
  },
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

function mount(onApproveNode = vi.fn(async () => undefined)) {
  const execution = { onApproveNode, onSubmitHumanForm: vi.fn(), onOpenRun: vi.fn() }
  const view = render(
    <div style={{ width: 1100, height: 760, display: 'flex' }}>
      <RunObservationWorkspace run={run} runNodes={runNodes} panel={null} permissions={['runs.read', 'runs.start']} execution={execution} />
    </div>,
  )
  return { ...view, execution }
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

  it('approves the exact tool call from the node and refreshes the map', async () => {
    const { execution } = mount()
    const approve = await screen.findByRole('button', { name: 'Approve Charge card' })
    approve.focus()
    expect(approve).toHaveFocus()
    expect((approve.closest('.react-flow') as HTMLElement).scrollTop).toBe(0)
    approve.click()
    expect(execution.onApproveNode).toHaveBeenCalledWith('gate', { approvalId: 'ta-1', paramsDigest: 'digest-1', decision: 'approve' })
    await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === `/v1/runs/${run.id}/map`).length).toBeGreaterThan(1))
  })
})
