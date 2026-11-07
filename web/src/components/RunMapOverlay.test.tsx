import { fireEvent, render, screen, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { RunMap, RunMapNodeOverlay } from '../run-map'
import { RunMapActionsContext, RunMapNodeFacts, RunMapNodeFlags, RunMapTotals, type RunMapActions } from './RunMapOverlay'

function overlay(overrides: Partial<RunMapNodeOverlay> = {}): RunMapNodeOverlay {
  return {
    attempts: 1, elapsedMs: 65_000, liveSince: null, costUsd: 0, tokens: 0,
    stuck: false, needsYou: false, childRunId: null, decision: null, rerun: false,
    ...overrides,
  }
}

function actionsMock(overrides: Partial<RunMapActions> = {}): RunMapActions {
  return { pendingNodeId: null, decide: vi.fn(), openForm: vi.fn(), rerun: vi.fn(), openRun: vi.fn(), ...overrides }
}

function renderFacts(value: RunMapNodeOverlay, actions: RunMapActions | null): ReactNode {
  return (
    <ReactFlowProvider>
      <RunMapActionsContext.Provider value={actions}>
        <RunMapNodeFacts nodeId="gate" title="Send invoice" overlay={value} />
      </RunMapActionsContext.Provider>
    </ReactFlowProvider>
  )
}

describe('run map node overlay', () => {
  it('shows attempts, elapsed time and cost as labelled facts', () => {
    render(renderFacts(overlay({ attempts: 2, costUsd: 0.0125, tokens: 1_200 }), null))
    const facts = screen.getByTestId('workflow-node-facts')
    expect(within(facts).getByText('Attempt 2')).toBeVisible()
    expect(within(facts).getByText('1m 5s')).toBeVisible()
    expect(within(facts).getByText('$0.013')).toBeVisible()
    expect(within(facts).getByText('AI cost')).toHaveClass('we-sr-only')
  })

  it('offers no action on the editor canvas', () => {
    render(renderFacts(overlay({ needsYou: true, decision: { kind: 'approval' }, rerun: true, childRunId: 'run-2' }), null))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('approves or denies a tool call in place, named after the step', () => {
    const actions = actionsMock()
    render(renderFacts(overlay({ needsYou: true, decision: { kind: 'tool_approval', approvalId: 'ta', paramsDigest: 'd' } }), actions))
    fireEvent.click(screen.getByRole('button', { name: 'Deny Send invoice' }))
    expect(actions.decide).toHaveBeenCalledWith('gate', 'deny')
    fireEvent.click(screen.getByRole('button', { name: 'Approve Send invoice' }))
    expect(actions.decide).toHaveBeenCalledWith('gate', 'approve')
  })

  it('disables the decision while it is being sent', () => {
    render(renderFacts(overlay({ needsYou: true, decision: { kind: 'approval' } }), actionsMock({ pendingNodeId: 'gate' })))
    expect(screen.getByRole('button', { name: 'Approve Send invoice' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Deny Send invoice' })).toBeNull()
  })

  it('opens the form, the rerun preview and the child run', () => {
    const actions = actionsMock()
    render(renderFacts(overlay({ needsYou: true, decision: { kind: 'human_form' }, rerun: true, childRunId: 'run-2' }), actions))
    fireEvent.click(screen.getByRole('button', { name: 'Fill in the form for Send invoice' }))
    expect(actions.openForm).toHaveBeenCalledWith('gate')
    fireEvent.click(screen.getByRole('button', { name: 'Rerun from Send invoice' }))
    expect(actions.rerun).toHaveBeenCalledWith('gate')
    fireEvent.click(screen.getByRole('button', { name: 'Open the child run of Send invoice' }))
    expect(actions.openRun).toHaveBeenCalledWith('run-2')
  })

  it('flags stuck and needs-you in text, not colour alone', () => {
    render(<RunMapNodeFlags overlay={overlay({ stuck: true, needsYou: true })} />)
    expect(screen.getByTestId('workflow-node-stuck')).toHaveTextContent('Stuck')
    expect(screen.getByTestId('workflow-node-needs-you')).toHaveTextContent('Needs you')
  })

  it('totals cost and tokens and counts what is stuck or waiting on the viewer', () => {
    const map: RunMap = {
      run: { id: 'run-1', status: 'running', workflowVersionId: 'v', parentRunId: null },
      nodes: [], lanes: [], totals: { costUsd: 1.5, tokens: 12_400 },
    }
    const overlays = new Map([
      ['a', overlay({ stuck: true })], ['b', overlay({ needsYou: true })], ['c', overlay({ needsYou: true })],
    ])
    render(<RunMapTotals map={map} overlays={overlays} />)
    const totals = screen.getByTestId('run-map-totals')
    expect(within(totals).getByText('$1.5')).toBeVisible()
    expect(within(totals).getByText('12.4K')).toBeVisible()
    expect(screen.getByTestId('run-map-stuck-count')).toHaveTextContent('1 stuck')
    expect(screen.getByRole('status')).toHaveTextContent('2 need you')
  })
})
