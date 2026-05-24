import { describe, expect, it } from 'vitest'
import {
  MIN_SAMPLE_SIZE,
  WorkflowSloSchema,
  evaluateWorkflowSlo,
  type WorkflowSlo,
  type WorkflowSloSignals,
} from './workflow-slo'

const emptySignals: WorkflowSloSignals = {
  totalRuns: 0,
  successCount: 0,
  p95LatencyMs: null,
}

const healthySignals: WorkflowSloSignals = {
  totalRuns: 20,
  successCount: 19,
  p95LatencyMs: 4_000,
  mttrSeconds: 60,
  budgetBlocksInWindow: 0,
  stuckWaitingNodesCount: 0,
}

const baseSlo: WorkflowSlo = {
  successRatePercent: null,
  mttrSeconds: null,
  p95DurationMs: null,
  budgetBlocksPerWindow: null,
  stuckWaitingNodesMax: null,
  windowDays: 7,
}

describe('WorkflowSloSchema', () => {
  it('accepts a fully populated SLO', () => {
    const parsed = WorkflowSloSchema.safeParse({
      successRatePercent: 99,
      mttrSeconds: 300,
      p95DurationMs: 10_000,
      budgetBlocksPerWindow: 0,
      stuckWaitingNodesMax: 0,
      windowDays: 14,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects out-of-range successRatePercent', () => {
    const parsed = WorkflowSloSchema.safeParse({
      ...baseSlo,
      successRatePercent: 150,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects negative mttrSeconds', () => {
    const parsed = WorkflowSloSchema.safeParse({ ...baseSlo, mttrSeconds: -1 })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-integer p95DurationMs', () => {
    const parsed = WorkflowSloSchema.safeParse({
      ...baseSlo,
      p95DurationMs: 100.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects windowDays outside the closed enum', () => {
    const parsed = WorkflowSloSchema.safeParse({ ...baseSlo, windowDays: 90 })
    expect(parsed.success).toBe(false)
  })
})

describe('evaluateWorkflowSlo', () => {
  it('returns no breaches for a null SLO', () => {
    const result = evaluateWorkflowSlo(null, healthySignals)
    expect(result.anyBreach).toBe(false)
    expect(result.successRatePercent).toBe(false)
    expect(result.p95DurationMs).toBe(false)
  })

  it('fires successRate breach when below threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, successRatePercent: 99 }
    // 19/20 = 95% — below 99% threshold.
    const result = evaluateWorkflowSlo(slo, healthySignals)
    expect(result.successRatePercent).toBe(true)
    expect(result.anyBreach).toBe(true)
  })

  it('does not fire successRate breach when at/above threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, successRatePercent: 95 }
    // 19/20 = 95% — exactly at threshold.
    const result = evaluateWorkflowSlo(slo, healthySignals)
    expect(result.successRatePercent).toBe(false)
    expect(result.anyBreach).toBe(false)
  })

  it('fires p95 breach when above threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, p95DurationMs: 3_000 }
    const result = evaluateWorkflowSlo(slo, healthySignals)
    expect(result.p95DurationMs).toBe(true)
    expect(result.anyBreach).toBe(true)
  })

  it('suppresses success-rate and p95 breaches below MIN_SAMPLE_SIZE', () => {
    const lowSampleSignals: WorkflowSloSignals = {
      totalRuns: MIN_SAMPLE_SIZE - 1,
      successCount: 0,
      p95LatencyMs: 999_999,
    }
    const slo: WorkflowSlo = {
      ...baseSlo,
      successRatePercent: 99,
      p95DurationMs: 1_000,
    }
    const result = evaluateWorkflowSlo(slo, lowSampleSignals)
    expect(result.successRatePercent).toBe(false)
    expect(result.p95DurationMs).toBe(false)
    expect(result.anyBreach).toBe(false)
  })

  it('does not fire p95 breach when latency is unmeasured (null)', () => {
    const slo: WorkflowSlo = { ...baseSlo, p95DurationMs: 1 }
    const result = evaluateWorkflowSlo(slo, {
      ...healthySignals,
      p95LatencyMs: null,
    })
    expect(result.p95DurationMs).toBe(false)
  })

  it('fires mttr breach when signal exceeds threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, mttrSeconds: 30 }
    const result = evaluateWorkflowSlo(slo, {
      ...healthySignals,
      mttrSeconds: 120,
    })
    expect(result.mttrSeconds).toBe(true)
    expect(result.anyBreach).toBe(true)
  })

  it('skips mttr breach when signal is unwired (undefined)', () => {
    const slo: WorkflowSlo = { ...baseSlo, mttrSeconds: 30 }
    const result = evaluateWorkflowSlo(slo, {
      totalRuns: 20,
      successCount: 19,
      p95LatencyMs: 4_000,
    })
    expect(result.mttrSeconds).toBe(false)
  })

  it('fires budget block breach when signal exceeds threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, budgetBlocksPerWindow: 0 }
    const result = evaluateWorkflowSlo(slo, {
      ...healthySignals,
      budgetBlocksInWindow: 3,
    })
    expect(result.budgetBlocksPerWindow).toBe(true)
  })

  it('fires stuck-waiting-nodes breach when signal exceeds threshold', () => {
    const slo: WorkflowSlo = { ...baseSlo, stuckWaitingNodesMax: 1 }
    const result = evaluateWorkflowSlo(slo, {
      ...healthySignals,
      stuckWaitingNodesCount: 5,
    })
    expect(result.stuckWaitingNodesMax).toBe(true)
  })

  it('returns all-false breaches with no samples', () => {
    const slo: WorkflowSlo = {
      ...baseSlo,
      successRatePercent: 99,
      p95DurationMs: 1,
    }
    const result = evaluateWorkflowSlo(slo, emptySignals)
    expect(result.anyBreach).toBe(false)
  })

  it('combines multiple breaches into anyBreach=true', () => {
    const slo: WorkflowSlo = {
      ...baseSlo,
      successRatePercent: 100,
      p95DurationMs: 1,
    }
    const result = evaluateWorkflowSlo(slo, healthySignals)
    expect(result.successRatePercent).toBe(true)
    expect(result.p95DurationMs).toBe(true)
    expect(result.anyBreach).toBe(true)
  })
})
