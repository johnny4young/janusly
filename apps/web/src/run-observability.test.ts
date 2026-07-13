import { describe, expect, it } from 'vitest'
import { getRunFinishedAt, getRunTerminalAt, getRunTriggerInput, getRunWaitingInfo, getRunWorkflowIdentity } from './run-observability'

describe('run observability projections', () => {
  it('extracts workflow identity and trigger input without exposing the workflow snapshot as input', () => {
    const run = {
      id: 'run-1',
      status: 'failed',
      inputJson: {
        workflow: { id: 'billing', name: 'Billing recovery', nodes: [{ id: 'fetch' }] },
        input: { invoiceId: 'inv-42' },
      },
    }
    expect(getRunWorkflowIdentity(run)).toEqual({ id: 'billing', name: 'Billing recovery' })
    expect(getRunTriggerInput(run)).toEqual({ invoiceId: 'inv-42' })
  })

  it('returns safe fallbacks for historical and malformed run payloads', () => {
    expect(getRunWorkflowIdentity({ id: 'run-1', status: 'running', inputJson: { workflow: 'bad' } })).toEqual({ id: null, name: null })
    expect(getRunTriggerInput({ id: 'run-1', status: 'running', inputJson: null })).toBeUndefined()
  })

  it('classifies current and legacy waiting metadata with stable timing fallbacks', () => {
    expect(getRunWaitingInfo({
      nodeId: 'approve',
      status: 'waiting',
      startedAt: '2026-07-12T10:00:00.000Z',
      stateJson: { waiting: { kind: 'approval', title: 'Approve refund', description: 'Check the evidence', waitingSince: '2026-07-12T10:01:00.000Z' } },
    })).toEqual({
      kind: 'approval',
      title: 'Approve refund',
      description: 'Check the evidence',
      waitingSince: '2026-07-12T10:01:00.000Z',
      wakeAt: null,
    })
    expect(getRunWaitingInfo({
      nodeId: 'pause',
      status: 'waiting',
      startedAt: '2026-07-12T10:00:00.000Z',
      stateJson: { waiting: { reason: 'Waiting for absolute time', wakeAt: '2026-07-12T11:00:00.000Z' } },
    })).toMatchObject({ kind: 'timer', waitingSince: '2026-07-12T10:00:00.000Z' })
  })

  it('uses the latest valid node finish as the terminal boundary', () => {
    expect(getRunFinishedAt([
      { nodeId: 'a', status: 'succeeded', finishedAt: '2026-07-12T10:00:02.000Z' },
      { nodeId: 'b', status: 'failed', finishedAt: '2026-07-12T10:00:05.000Z' },
      { nodeId: 'c', status: 'skipped', finishedAt: 'bad' },
    ])).toBe('2026-07-12T10:00:05.000Z')
  })

  it('prefers the persisted terminal run event timestamp when available', () => {
    expect(getRunTerminalAt([
      { id: '3', type: 'run.cancelled', createdAt: '2026-07-12T10:00:09.000Z' },
      { id: '1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: '2', type: 'run.failed', createdAt: '2026-07-12T10:00:08.000Z' },
    ])).toBe('2026-07-12T10:00:09.000Z')
    expect(getRunTerminalAt([{ id: '1', type: 'node.failed', createdAt: '2026-07-12T10:00:08.000Z' }])).toBeNull()
  })
})
