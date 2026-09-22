import { describe, expect, it } from 'vitest'
import { isRecoveryDelta, type RecoveryDelta } from './health-delta'

const fixture = (): RecoveryDelta => ({
  workflowId: 'workflow', afterVersion: 2, windowDays: 30, hasEnoughData: true,
  before: { score: 80, status: 'healthy', signals: { totalRuns: 8, p95LatencyMs: 10, totalCostUsd: 1 } },
  after: { score: 70, status: 'warn', signals: { totalRuns: 5, p95LatencyMs: 20, totalCostUsd: 1 } },
  delta: { score: -10, p95LatencyMs: 10, costPerRunUsd: .075 },
  recentRunsAgainstAfter: { totalRuns: 6, succeeded: 4, failed: 1, running: 1 },
  priorVersion: { version: 1, versionId: 'prior' },
  sameFailureSinceApply: { count: 1, sampleDeadLetterIds: ['dead-letter'], priorSignature: 'signature' },
})
const accepts = (value: unknown) => isRecoveryDelta(value, 'workflow', 2, 'signature')

describe('recovery health wire boundary', () => {
  it('accepts a bounded projection without equating terminal health and in-flight run counts', () => {
    expect(accepts(fixture())).toBe(true)
  })
  it('accepts no prior row, nullable latency/cost and missing signature analysis', () => {
    const data = fixture()
    data.priorVersion = data.sameFailureSinceApply = null
    data.before.signals.p95LatencyMs = null
    data.delta!.p95LatencyMs = data.delta!.costPerRunUsd = null
    expect(accepts(data)).toBe(true)
  })
  it('accepts gathering only below the terminal sample floor and with no delta', () => {
    const data = fixture()
    data.after.signals.totalRuns = 4
    data.hasEnoughData = false
    data.delta = null
    expect(accepts(data)).toBe(true)
  })
  it.each([
    ['invalid score', (d: RecoveryDelta) => { d.before.score = 101 }],
    ['invalid status', (d: RecoveryDelta) => { d.after.status = 'unknown' }],
    ['negative cost', (d: RecoveryDelta) => { d.after.signals.totalCostUsd = -1 }],
    ['infinite latency', (d: RecoveryDelta) => { d.after.signals.p95LatencyMs = Infinity }],
    ['negative latency', (d: RecoveryDelta) => { d.after.signals.p95LatencyMs = -1 }],
    ['fractional count', (d: RecoveryDelta) => { d.after.signals.totalRuns = 1.5 }],
    ['inconsistent delta', (d: RecoveryDelta) => { d.delta!.score = 10 }],
    ['nonfinite delta', (d: RecoveryDelta) => { d.delta!.costPerRunUsd = NaN }],
    ['unbounded window', (d: RecoveryDelta) => { d.windowDays = 31 }],
    ['inconsistent run totals', (d: RecoveryDelta) => { d.recentRunsAgainstAfter.running = 7 }],
    ['noncanonical prior id', (d: RecoveryDelta) => { d.priorVersion!.versionId = ' prior' }],
    ['duplicate evidence', (d: RecoveryDelta) => { d.sameFailureSinceApply!.count = 2; d.sameFailureSinceApply!.sampleDeadLetterIds = ['id', 'id'] }],
    ['excessive evidence', (d: RecoveryDelta) => { d.sameFailureSinceApply!.count = 6; d.sameFailureSinceApply!.sampleDeadLetterIds = ['a','b','c','d','e','f'] }],
  ] as const)('rejects %s', (_label, mutate) => {
    const data = fixture()
    mutate(data)
    expect(accepts(data)).toBe(false)
  })
  it.each([null, [], {}, { ...fixture(), before: null }, { ...fixture(), delta: undefined }, { ...fixture(), priorVersion: undefined }, { ...fixture(), sameFailureSinceApply: undefined }])('rejects malformed nullable object %#', value => {
    expect(accepts(value)).toBe(false)
  })
})
