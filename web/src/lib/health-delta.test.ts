import { describe, expect, it } from 'vitest'
import { healthDelta } from '../test/health-delta-fixture'
import { isRecoveryDelta, type RecoveryDelta } from './health-delta'

const fixture = (): RecoveryDelta => healthDelta({
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
  it('accepts a projection without equating terminal health and in-flight run counts', () => {
    expect(accepts(fixture())).toBe(true)
  })
  it('accepts no prior row, nullable latency/cost and missing signature analysis', () => {
    const data = fixture()
    data.priorVersion = data.sameFailureSinceApply = null
    data.before.signals.p95LatencyMs = null
    data.delta!.p95LatencyMs = data.delta!.costPerRunUsd = null
    expect(accepts(data)).toBe(true)
  })
  it('leaves the sample floor, sample cap, score range and window bound to the server', () => {
    const gathering = fixture()
    gathering.after.signals.totalRuns = 40
    gathering.hasEnoughData = false
    gathering.delta = null
    expect(accepts(gathering)).toBe(true)
    const tuned = fixture()
    tuned.after.signals.totalRuns = 2
    tuned.windowDays = 0
    tuned.before.score = 101
    tuned.after.signals.totalCostUsd = -1
    tuned.priorVersion!.version = 0
    tuned.sameFailureSinceApply!.count = 9
    tuned.sameFailureSinceApply!.sampleDeadLetterIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(isRecoveryDelta({ ...tuned, afterVersion: 4 }, 'workflow', 4, 'signature')).toBe(true)
  })
  it.each([null, [], {}, { ...fixture(), before: null }, { ...fixture(), delta: undefined }, { ...fixture(), windowDays: 1.5 }])(
    'delegates shape to the generated guard %#', value => {
      expect(accepts(value)).toBe(false)
    })
  it.each([
    ['another workflow', (d: RecoveryDelta) => { d.workflowId = 'other' }],
    ['another version', (d: RecoveryDelta) => { d.afterVersion = 3 }],
    ['delta while gathering', (d: RecoveryDelta) => { d.hasEnoughData = false }],
    ['missing delta with enough data', (d: RecoveryDelta) => { d.delta = null }],
    ['inconsistent run totals', (d: RecoveryDelta) => { d.recentRunsAgainstAfter.running = 7 }],
    ['prior not older than applied version', (d: RecoveryDelta) => { d.priorVersion!.version = 2 }],
    ['foreign failure signature', (d: RecoveryDelta) => { d.sameFailureSinceApply!.priorSignature = 'other' }],
    ['duplicate evidence', (d: RecoveryDelta) => { d.sameFailureSinceApply!.count = 2; d.sameFailureSinceApply!.sampleDeadLetterIds = ['id', 'id'] }],
    ['more samples than failures', (d: RecoveryDelta) => { d.sameFailureSinceApply!.sampleDeadLetterIds = ['a', 'b'] }],
  ] as const)('rejects %s', (_label, mutate) => {
    const data = fixture()
    mutate(data)
    expect(accepts(data)).toBe(false)
  })
  it('rejects failure evidence when no signature was asked about', () => {
    expect(isRecoveryDelta(fixture(), 'workflow', 2, null)).toBe(false)
  })
})
