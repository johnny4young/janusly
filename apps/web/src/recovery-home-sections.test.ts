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

const metric = {
  value: 93,
  display: '93%',
  severity: 'healthy',
  rationale: 'Healthy sample',
}

const metrics = {
  successRate: metric,
  verifiedRecovery: {
    ...metric,
    definitionVersion: '1',
    metric: 'time_to_verified_recovery',
    unit: 'milliseconds',
    sampleSize: 2,
    p50Ms: 120_000,
    p90Ms: 180_000,
  },
  mttr: metric,
  p95Latency: metric,
  approvalsPending: metric,
  replayRate: metric,
  recurrenceRate: metric,
  windowDays: 30,
  terminalRuns: 4,
}

describe('Recovery Home section decoders', () => {
  it('accepts the supported recovery section shapes', () => {
    expect(decodeRecoveryMetrics(metrics)).toEqual(metrics)
    expect(decodeClustersResponse({
      clusters: [{
        signature: 'http:timeout',
        category: 'network_timeout',
        frequency: 2,
        suggestedOwner: 'platform',
        lastSeen: '2026-07-27T12:00:00.000Z',
      }],
      totalSamples: 2,
      windowDays: 30,
    })).not.toBeNull()
    expect(decodeHeatmap({
      days: [{
        day: '2026-07-27',
        failures: 2,
        recovered: 1,
        mttrSeconds: 90,
      }],
      windowDays: 90,
    })).toEqual({
      days: [{
        day: '2026-07-27',
        failures: 2,
        recovered: 1,
        mttrSeconds: 90,
      }],
    })
    expect(decodeRecoveryLedger({
      totalRecovered: 3,
      downtimeEndedMs: 240_000,
      sinceIso: null,
    })).not.toBeNull()
    expect(decodeOperatorWins({
      recovered: 1,
      windowDays: 30,
    })).not.toBeNull()
    expect(decodeRecoveryQueue({
      counts: { open: 1 },
      oldestOpen: { createdAt: '2026-07-27T12:00:00.000Z' },
    })).not.toBeNull()
  })

  it('rejects malformed nested metrics and queue projections independently', () => {
    expect(decodeRecoveryMetrics({
      ...metrics,
      replayRate: { ...metric, display: 42 },
    })).toBeNull()
    expect(decodeRecoveryMetrics({
      ...metrics,
      valueEstimate: {
        hoursSaved: 4,
        dollarSaved: 200,
        mttrDeltaSeconds: null,
        assumptions: null,
      },
    })).toBeNull()
    expect(decodeRecoveryQueue({
      counts: { open: -1 },
      oldestOpen: null,
    })).toBeNull()
  })

  it('rejects incomplete validation, semantic-case, and heatmap rows', () => {
    expect(decodeRecoveryValidationReport({
      generatedAt: '2026-07-27T12:00:00.000Z',
      windowDays: 30,
      sampleLimit: 100,
      sampleCapped: false,
      totals: {},
      resolution: {},
      timing: {},
      byFailureMode: [],
    })).toBeNull()
    expect(decodeRecoveryCases({
      cases: [{
        id: 'case-incomplete',
        runId: 'run-1',
        action: 'quarantine',
      }],
    })).toBeNull()
    expect(decodeHeatmap({
      days: [{ day: '2026-07-27', failures: 'two' }],
    })).toBeNull()
  })
})
