import { describe, expect, it } from 'vitest'

import {
  decodeClustersResponse,
  decodeHeatmap,
  decodeRecoveryCases,
  decodeRecoveryMetrics,
  decodeRecoveryQueue,
} from './recovery-home-sections'

const metric = { value: 93, display: '93%', severity: 'healthy', rationale: 'Healthy sample', rationaleCode: 'ok' }
const verifiedRecovery = {
  ...metric, definitionVersion: '1', metric: 'time_to_verified_recovery', unit: 'milliseconds',
  sampleSize: 2, p50Ms: 120_000, p90Ms: 180_000,
}
const cluster = {
  signature: 'http:timeout', category: 'network_timeout', frequency: 2, suggestedOwner: 'platform',
  firstSeen: '2026-07-27T12:00:00.000Z', lastSeen: '2026-07-27T12:00:00.000Z',
  recurredAfterRecovery: false, affectedWorkflows: [], samples: [],
}

// Section values arrive after the `GET /recovery/home` guard; these readers keep projections and UI invariants.
describe('Recovery Home section readers', () => {
  it('formats verified recovery only for the one metric the tile knows', () => {
    expect(decodeRecoveryMetrics({ successRate: metric, verifiedRecovery })).not.toBeNull()
    expect(decodeRecoveryMetrics({ successRate: metric, verifiedRecovery: { ...verifiedRecovery, unit: 'seconds' } })).toBeNull()
    expect(decodeRecoveryMetrics({ successRate: metric, verifiedRecovery: { ...verifiedRecovery, definitionVersion: '2' } })).toBeNull()
  })

  it('rejects cluster categories and owners the tiles cannot label', () => {
    expect(decodeClustersResponse({ clusters: [cluster], totalSamples: 2, windowDays: 30 })).not.toBeNull()
    expect(decodeClustersResponse({ clusters: [{ ...cluster, category: 'quota' }], totalSamples: 2, windowDays: 30 })).toBeNull()
    expect(decodeClustersResponse({ clusters: [{ ...cluster, suggestedOwner: 'finance' }], totalSamples: 2, windowDays: 30 })).toBeNull()
  })

  it('projects only the fields the Recovery Center reads', () => {
    const day = { day: '2026-07-27', failures: 2, recovered: 1, mttrSeconds: 90 }
    expect(decodeHeatmap({ days: [day], windowDays: 90 })).toEqual({ days: [day] })
    expect(decodeRecoveryQueue({
      counts: { open: 1, replayed: 0, resolved: 0, total: 1 },
      oldestOpen: { id: 'dead-letter', createdAt: '2026-07-27T12:00:00.000Z' },
    })).toEqual({ counts: { open: 1 }, oldestOpen: { createdAt: '2026-07-27T12:00:00.000Z' } })
    expect(decodeRecoveryQueue({ counts: { open: 0, replayed: 0, resolved: 0, total: 0 }, oldestOpen: null }))
      .toEqual({ counts: { open: 0 }, oldestOpen: null })
  })

  it('reads the home case summary rather than requiring the full case record', () => {
    const summary = {
      id: 'case-1', runId: 'run-1', action: 'quarantine', state: 'contained', createdAt: '2026-07-27T12:00:00.000Z',
      detectorId: 'detector', detectorKind: 'expression', message: 'Output violated its contract',
      source: 'semantic_violation', workflowId: null,
    }
    expect(decodeRecoveryCases({ cases: [summary] })).toEqual({ cases: [summary] })
  })
})
