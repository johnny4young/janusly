import { describe, expect, it } from 'vitest'
import { parseFailureClusters, readRecoveryMetric } from './recovery-metrics-model'

const malformed: unknown[] = [undefined, null, 'garbage', 42, [], {}, { clusters: null }, { clusters: 'nope' }]

describe('parseFailureClusters', () => {
  it('returns null for every payload that is not a cluster response', () => {
    for (const payload of malformed) {
      expect(parseFailureClusters(payload), JSON.stringify(payload)).toBeNull()
    }
  })

  it('keeps well-formed clusters and drops rows that lack a signature', () => {
    const parsed = parseFailureClusters({
      clusters: [
        {
          signature: 'HTTP 503 from billing',
          category: 'http_error',
          frequency: 31,
          affectedWorkflows: [{ workflowId: 'wf_a', workflowName: 'A', count: 24 }, { bogus: true }],
          firstSeen: '2026-08-21T04:12:00.000Z',
          lastSeen: '2026-08-26T02:00:30.000Z',
          suggestedOwner: 'ops',
          samples: [{ source: 'dead_letter', id: 'dlq_1', runId: 'run_1' }, null],
        },
        { category: 'unknown' },
      ],
      totalSamples: 68,
      windowDays: 7,
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.clusters).toHaveLength(1)
    expect(parsed?.clusters[0].affectedWorkflows).toHaveLength(1)
    expect(parsed?.clusters[0].samples).toHaveLength(1)
    expect(parsed?.totalSamples).toBe(68)
  })

  it('normalises unknown categories, owners and counts instead of throwing', () => {
    const parsed = parseFailureClusters({
      clusters: [{ signature: 'x', category: 'made_up', suggestedOwner: 'nobody', frequency: -3 }],
    })
    expect(parsed?.clusters[0]).toMatchObject({ category: 'unknown', suggestedOwner: 'ops', frequency: 0 })
    expect(parsed?.windowDays).toBe(0)
  })
})

describe('readRecoveryMetric', () => {
  it('yields a neutral placeholder for anything that is not a metric', () => {
    for (const value of [undefined, null, 'x', 1, []]) {
      expect(readRecoveryMetric(value)).toEqual({ value: null, display: '—', severity: 'neutral', rationale: '' })
    }
  })

  it('keeps the severity vocabulary closed', () => {
    expect(readRecoveryMetric({ severity: 'critical', display: '9', value: 9, rationale: 'r' }).severity).toBe('neutral')
    expect(readRecoveryMetric({ severity: 'unhealthy', display: '9', value: 9, rationale: 'r' }).severity).toBe('unhealthy')
  })
})
