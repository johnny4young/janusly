import { describe, expect, it } from 'vitest'
import {
  createRunSummaryUpdateCoordinator,
  mergeRunSummaryPage,
  mergeRunSummaryPageWithPatches,
  patchRunSummaryList,
} from './useBootstrapData'

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

  it('keeps a newer live patch authoritative over an older list snapshot', () => {
    const current = [{
      id: 'run-1',
      status: 'succeeded',
      outcomeStatus: 'semantic_recovered' as const,
    }]
    expect(mergeRunSummaryPageWithPatches(
      current,
      [{ id: 'run-1', status: 'running', outcomeStatus: 'semantic_recovered' }],
      [{ runId: 'run-1', patch: { status: 'succeeded' } }],
    )).toEqual([{
      id: 'run-1',
      status: 'succeeded',
      outcomeStatus: 'semantic_recovered',
    }])
  })

  it('invalidates an in-flight snapshot when a newer run update is reserved', () => {
    const coordinator = createRunSummaryUpdateCoordinator()
    const pollingRevision = coordinator.reserve('run-1')
    const liveRevision = coordinator.reserve('run-1')

    expect(coordinator.isCurrent('run-1', pollingRevision)).toBe(false)
    expect(coordinator.isCurrent('run-1', liveRevision)).toBe(true)
  })

  it('tracks async summary ownership independently for each run', () => {
    const coordinator = createRunSummaryUpdateCoordinator()
    const firstRunRevision = coordinator.reserve('run-1')
    coordinator.reserve('run-2')

    expect(coordinator.isCurrent('run-1', firstRunRevision)).toBe(true)
  })
})
