import { describe, expect, it } from 'vitest'
import {
  deadLetterRowTone,
  isBulkReplayResult,
  isBulkResolveResult,
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
