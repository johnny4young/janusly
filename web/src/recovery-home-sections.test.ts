import { describe, expect, it } from 'vitest'

import {
  decodeClustersResponse,
  decodeHeatmap,
  decodeOperatorWins,
  decodeRecoveryCases,
  decodeRecoveryLedger,
  decodeRecoveryMetrics,
  decodeRecoveryQueue,
  decodeRecoveryValidationReport,
} from './recovery-home-sections'
import { recoveryMetrics } from './test/recovery-home-fixture'

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

describe('Recovery Home section readers', () => {
  it('formats verified recovery only for the one metric the tile knows', () => {
    const metrics = (verified: object) => recoveryMetrics({ successRate: metric, verifiedRecovery: verified })
    expect(decodeRecoveryMetrics(metrics(verifiedRecovery))).not.toBeNull()
    expect(decodeRecoveryMetrics(metrics({ ...verifiedRecovery, unit: 'seconds' }))).toBeNull()
    expect(decodeRecoveryMetrics(metrics({ ...verifiedRecovery, definitionVersion: '2' }))).toBeNull()
  })

  it('delegates section shape to the generated component guards', () => {
    expect(decodeRecoveryMetrics({ successRate: metric, verifiedRecovery })).toBeNull()
    expect(decodeClustersResponse({ clusters: [cluster], totalSamples: '2', windowDays: 30 })).toBeNull()
    expect(decodeHeatmap({ days: [] })).toBeNull()
    expect(decodeRecoveryQueue({ counts: { open: 1 }, oldestOpen: null })).toBeNull()
    expect(decodeRecoveryCases({ cases: [{ id: 'case-1' }] })).toBeNull()
    expect(decodeRecoveryLedger({ totalRecovered: 1, downtimeEndedMs: 0, sinceIso: null, extra: true })).toBeNull()
    expect(decodeOperatorWins({ recovered: 1.5, windowDays: 30 })).toBeNull()
    expect(decodeRecoveryValidationReport(null)).toBeNull()
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
      oldestOpen: {
        id: 'dead-letter', orgId: 'org', runId: 'run', nodeId: 'node', nodeType: null, attempt: 1, status: 'open',
        errorJson: null, createdAt: '2026-07-27T12:00:00.000Z', replayedAt: null, workflowName: null, recovery: null,
      },
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
