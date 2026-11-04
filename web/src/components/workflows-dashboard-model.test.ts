import { describe, expect, it } from 'vitest'
import type { FlowsSort } from '../flows-filters'
import type { SavedWorkflow } from '../types'
import {
  sortFlows,
  UNGROUPED_FOLDER,
  updateCollapsedFolders,
} from './workflows-dashboard-model'

describe('workflows dashboard model', () => {
  it('uses a non-colliding sentinel for the synthetic ungrouped folder', () => {
    expect(UNGROUPED_FOLDER).toBe('')
  })

  it('updates collapsed folders without allocating for native no-op toggles', () => {
    const collapsed = ['finance']

    expect(updateCollapsedFolders(collapsed, 'finance', false)).toBe(collapsed)
    expect(updateCollapsedFolders(collapsed, 'finance', true)).toEqual([])
    expect(updateCollapsedFolders(collapsed, 'support', false)).toEqual([
      'finance',
      'support',
    ])
  })
})

const flow = (id: string, extra: Partial<SavedWorkflow> = {}): SavedWorkflow => ({ id, orgId: 'o', name: id, ...extra })
const ids = (rows: SavedWorkflow[]) => rows.map(row => row.id)
const sorted = (rows: SavedWorkflow[], sort: FlowsSort, scores = {}) => ids(sortFlows(rows, sort, scores, 'en'))

describe('sortFlows', () => {
  it('sorts by name in both directions', () => {
    const rows = [flow('b'), flow('a'), flow('c')]
    expect(sorted(rows, { key: 'name', direction: 'asc' })).toEqual(['a', 'b', 'c'])
    expect(sorted(rows, { key: 'name', direction: 'desc' })).toEqual(['c', 'b', 'a'])
  })

  it('sorts by last run and lets never-run flows fall back to their creation time', () => {
    const rows = [
      flow('old-run', { lastRunAt: '2026-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' }),
      flow('never', { createdAt: '2026-02-01T00:00:00Z' }),
      flow('new-run', { lastRunAt: '2026-03-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' }),
    ]
    expect(sorted(rows, { key: 'lastRun', direction: 'desc' })).toEqual(['new-run', 'never', 'old-run'])
    expect(sorted(rows, { key: 'lastRun', direction: 'asc' })).toEqual(['old-run', 'never', 'new-run'])
  })

  it('keeps the old failed-first order on status, breaking ties by recency', () => {
    const rows = [
      flow('ok', { lastRunStatus: 'succeeded', lastRunAt: '2026-03-01T00:00:00Z' }),
      flow('idle'),
      flow('timed-out', { lastRunStatus: 'timed_out', lastRunAt: '2026-01-01T00:00:00Z' }),
      flow('paused', { status: 'paused_circuit_breaker' }),
      flow('failed', { lastRunStatus: 'failed', lastRunAt: '2026-02-01T00:00:00Z' }),
    ]
    expect(sorted(rows, { key: 'status', direction: 'asc' })).toEqual(['failed', 'timed-out', 'paused', 'ok', 'idle'])
  })

  it('sorts by open failures and version numerically', () => {
    const rows = [
      flow('two', { openFailureCount: 2, currentVersion: 10 }),
      flow('ten', { openFailureCount: 10, currentVersion: 2 }),
      flow('none', { openFailureCount: 0, currentVersion: 1 }),
    ]
    expect(sorted(rows, { key: 'openFailures', direction: 'desc' })).toEqual(['ten', 'two', 'none'])
    expect(sorted(rows, { key: 'version', direction: 'desc' })).toEqual(['two', 'ten', 'none'])
  })

  it('sorts by health and keeps unscored rows last in both directions', () => {
    const rows = [flow('pending'), flow('good'), flow('bad')]
    const scores = { good: 91, bad: 51 }
    expect(sorted(rows, { key: 'health', direction: 'asc' }, scores)).toEqual(['bad', 'good', 'pending'])
    expect(sorted(rows, { key: 'health', direction: 'desc' }, scores)).toEqual(['good', 'bad', 'pending'])
  })

  it('does not mutate the loaded rows', () => {
    const rows = [flow('b'), flow('a')]
    sortFlows(rows, { key: 'name', direction: 'asc' }, {}, 'en')
    expect(ids(rows)).toEqual(['b', 'a'])
  })
})
