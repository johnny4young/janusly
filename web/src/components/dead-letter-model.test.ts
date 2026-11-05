import { describe, expect, it } from 'vitest'
import {
  deadLetterRowTone,
  groupQueueByCluster,
  isBulkReplayResult,
  isBulkResolveResult,
  queueListItems,
  triageQueueSignature,
} from './dead-letter-model'
import type { DeadLetter } from './dead-letter-types'

function row(id: string, status: DeadLetter['status']): DeadLetter {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    attempt: 1,
    status,
    errorJson: {},
  }
}

describe('dead-letter model', () => {
  it('recognizes bounded partial-success envelopes', () => {
    expect(isBulkResolveResult({ resolved: 1, failed: 0, errors: [] })).toBe(true)
    expect(isBulkReplayResult({ replayed: 1, failed: 0, errors: [] })).toBe(true)
    expect(isBulkResolveResult({ replayed: 1, failed: 0, errors: [] })).toBe(false)
    expect(isBulkReplayResult(null)).toBe(false)
  })

  it('captures queue identity and status for focus reconciliation', () => {
    expect(triageQueueSignature([
      row('a', 'open'),
      row('b', 'resolved'),
    ])).toBe('a:open|b:resolved')
  })

  it('maps queue status to the stable visual tone contract', () => {
    expect(deadLetterRowTone('open')).toBe('danger')
    expect(deadLetterRowTone('replayed')).toBe('success')
    expect(deadLetterRowTone('resolved')).toBe('cobalt')
  })
})

describe('groupQueueByCluster', () => {
  const failing = (id: string, message: string, workflowName: string | null = 'Ingest'): DeadLetter => ({
    ...row(id, 'open'), errorJson: { message }, nodeType: 'http', workflowName,
  })
  const dns = 'dial tcp: lookup a.invalid: no such host'
  const secret = 'Missing secret: TOKEN'
  const cluster = {
    signature: 'DNS lookup failed on http node', category: 'network_timeout' as const, frequency: 9,
    affectedWorkflows: [{ workflowId: 'a', workflowName: 'Feed', count: 9 }],
    firstSeen: '', lastSeen: '', suggestedOwner: 'workflow_author' as const, samples: [],
  }

  it('keeps first-row order, so the chosen sort still decides which cluster leads', () => {
    const groups = groupQueueByCluster([failing('a', secret), failing('b', dns), failing('c', secret)], [])
    expect(groups.map(group => [group.signature, group.rows.map(item => item.id)])).toEqual([
      ['Missing secret: TOKEN', ['a', 'c']],
      ['DNS lookup failed on http node', ['b']],
    ])
  })

  it('takes totals from the rollup and never reports fewer than the loaded rows', () => {
    const [group] = groupQueueByCluster([failing('a', dns)], [cluster])
    expect(group).toMatchObject({ frequency: 9, workflowNames: ['Feed'], category: 'network_timeout' })
    const [small] = groupQueueByCluster([failing('a', dns), failing('b', dns)], [{ ...cluster, frequency: 1 }])
    expect(small?.frequency).toBe(2)
  })

  it('falls back to the loaded rows outside the rollup and skips rows without a workflow name', () => {
    const [group] = groupQueueByCluster([failing('a', secret), failing('b', secret), failing('c', secret, 'Billing'), failing('d', secret, null)], [])
    expect(group).toMatchObject({ frequency: 4, workflowNames: ['Ingest', 'Billing'], category: 'secret_missing' })
  })
})

describe('queueListItems', () => {
  const rows = [row('a', 'open'), row('b', 'open')]

  it('is flat without groups and puts each header before its rows with them', () => {
    expect(queueListItems(rows, null).map(item => item.kind)).toEqual(['row', 'row'])
    const groups = groupQueueByCluster(rows, [])
    expect(queueListItems(rows, groups).map(item => item.kind)).toEqual(['cluster', 'row', 'row'])
  })
})
