import { describe, expect, it } from 'vitest'
import { mergeRunSummaryPage, patchRunSummaryList } from './useBootstrapData'

describe('run summary live merging', () => {
  it('patches an existing status without discarding detail-only fields', () => {
    const current = [{ id: 'run-1', status: 'running', traceId: 'trace-1', inputJson: { input: { invoiceId: '42' } } }]
    expect(patchRunSummaryList(current, 'run-1', { status: 'failed' })).toEqual([
      { id: 'run-1', status: 'failed', traceId: 'trace-1', inputJson: { input: { invoiceId: '42' } } },
    ])
  })

  it('materializes a status-only summary when SSE wins the race with the list fetch', () => {
    expect(patchRunSummaryList([], 'run-1', { status: 'running' })).toEqual([{ id: 'run-1', status: 'running' }])
    expect(patchRunSummaryList([], 'run-1', { traceId: 'trace-1' })).toEqual([])
  })

  it('keeps the requested run id authoritative when merging a full API row', () => {
    expect(patchRunSummaryList(
      [{ id: 'run-1', status: 'running' }],
      'run-1',
      { id: 'unexpected', status: 'failed' },
    )).toEqual([{ id: 'run-1', status: 'failed' }])
  })

  it('accepts list status as authoritative while preserving selected-run detail', () => {
    const current = [{ id: 'run-1', status: 'running', traceId: 'trace-1', inputJson: { input: { invoiceId: '42' } } }]
    expect(mergeRunSummaryPage(current, [{ id: 'run-1', status: 'succeeded', outputJson: { result: 'ok' } }])).toEqual([
      { id: 'run-1', status: 'succeeded', traceId: 'trace-1', inputJson: { input: { invoiceId: '42' } }, outputJson: { result: 'ok' } },
    ])
  })
})
