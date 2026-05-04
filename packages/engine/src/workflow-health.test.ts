import { describe, expect, it } from 'vitest'
import type { Workflow } from '@janusly/shared'
import {
  BREAKDOWN_WEIGHTS,
  NEUTRAL_DEFAULT,
  computeWorkflowHealth,
  type HealthSignals,
} from './workflow-health'
import type { ReadinessResult } from './workflow-readiness'

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    dslVersion: '1.0',
    nodes: [],
    edges: [],
    ...partial,
  } as Workflow
}

const cleanReadiness: ReadinessResult = { status: 'pass', issues: [] }

const noopWorkflow = makeWorkflow({
  nodes: [{ id: 'noop', type: 'noop', config: {} }],
  outputs: { result: '{{context.noop.output}}' },
})

const baseSignals: HealthSignals = {
  totalRuns: 0,
  successCount: 0,
  failureCount: 0,
  retryCount: 0,
  dlqOpenCount: 0,
  p95LatencyMs: null,
  totalCostUsd: 0,
  totalTokens: 0,
  versionCount: 1,
}

describe('computeWorkflowHealth — category breakdown', () => {
  it('reliability lands at 100 when every run succeeded with no DLQ + no retry', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 30, successCount: 30 },
    })
    expect(result.breakdown.reliability.score).toBe(100)
  })

  it('reliability dips with failures', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 30, successCount: 25, failureCount: 5 },
    })
    expect(result.breakdown.reliability.score).toBeLessThan(90)
    expect(result.breakdown.reliability.score).toBeGreaterThan(70)
  })

  it('reliability dips with open DLQ entries up to the cap', () => {
    const lowDlq = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 10, successCount: 10, dlqOpenCount: 2 },
    })
    const cappedDlq = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 10, successCount: 10, dlqOpenCount: 100 },
    })
    expect(lowDlq.breakdown.reliability.score).toBe(90) // 100 - 2*5
    expect(cappedDlq.breakdown.reliability.score).toBe(70) // 100 - 30 (cap)
  })

  it('reliability is neutral when there are no runs at all', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: baseSignals,
    })
    expect(result.breakdown.reliability.score).toBe(NEUTRAL_DEFAULT)
  })

  it('safety penalises readiness fail and warn issues', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: {
        status: 'fail',
        issues: [
          { code: 'external_node_missing_retry', severity: 'fail', message: 'no retry' },
          { code: 'http_missing_bounds', severity: 'warn', message: 'no bounds' },
          { code: 'workflow_missing_outputs', severity: 'warn', message: 'no outputs' },
        ],
      },
      signals: baseSignals,
    })
    expect(result.breakdown.safety.score).toBe(70) // 100 - 1*20 - 2*5
  })

  it('cost lands in the middle of the band for moderate cost-per-run', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 10, successCount: 10, totalCostUsd: 5 }, // $0.50 / run
    })
    // $0.01 → 100, $1.00 → 30. Linear in $0.99 span. costPerRun=0.50 → t=(0.5-0.01)/0.99 ≈ 0.495
    expect(result.breakdown.cost.score).toBeGreaterThan(60)
    expect(result.breakdown.cost.score).toBeLessThan(70)
  })

  it('latency neutral when p95 is null', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, p95LatencyMs: null },
    })
    expect(result.breakdown.latency.score).toBe(NEUTRAL_DEFAULT)
  })

  it('latency lands at 100 for fast workflows and dips for slow ones', () => {
    const fast = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 10, successCount: 10, p95LatencyMs: 800 },
    })
    const slow = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 10, successCount: 10, p95LatencyMs: 30_000 },
    })
    expect(fast.breakdown.latency.score).toBe(100)
    expect(slow.breakdown.latency.score).toBeLessThan(70)
    expect(slow.breakdown.latency.score).toBeGreaterThan(50)
  })

  it('maintainability rewards declared outputs, multiple versions, and an approval node', () => {
    const richWorkflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'gate', type: 'approval', config: { message: 'review' } },
      ],
      outputs: { result: 'ok' },
    })
    const result = computeWorkflowHealth({
      workflow: richWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, versionCount: 3 },
    })
    expect(result.breakdown.maintainability.score).toBe(100)
  })

  it('maintainability is low for a workflow with no outputs, single version, no approval', () => {
    const result = computeWorkflowHealth({
      workflow: makeWorkflow({ nodes: [{ id: 'start', type: 'noop', config: {} }] }), // no outputs
      readiness: { status: 'warn', issues: [{ code: 'workflow_missing_outputs', severity: 'warn', message: 'missing' }] },
      signals: { ...baseSignals, versionCount: 1 },
    })
    // 30 (no outputs) + 10 (single version) + 10 (no approval) = 50
    expect(result.breakdown.maintainability.score).toBe(50)
  })

  it('aiRisk lands at 100 when there are no AI / agent nodes', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: baseSignals,
    })
    expect(result.breakdown.aiRisk.score).toBe(100)
  })

  it('aiRisk penalises AI nodes plus hardcoded secrets', () => {
    const aiHeavy = makeWorkflow({
      nodes: [
        { id: 'a', type: 'ai', config: { prompt: 'hi' } },
        { id: 'b', type: 'agent', config: { goal: 'do stuff' } },
        { id: 'c', type: 'multi_agent', config: { goal: 'team', agents: [{ name: 'x', role: 'r', goal: 'g' }] } },
      ],
    })
    const result = computeWorkflowHealth({
      workflow: aiHeavy,
      readiness: { status: 'fail', issues: [{ code: 'raw_secret_in_config', severity: 'fail', message: 'token literal' }] },
      signals: { ...baseSignals, totalTokens: 200_000 },
    })
    // 100 - 3*5 (ai nodes) - 200_000/100_000 * 1 (tokens) - 1*30 (raw secret) = 53
    expect(result.breakdown.aiRisk.score).toBe(53)
  })
})

describe('computeWorkflowHealth — overall rollup', () => {
  it('weights sum to 1.0 (rounded to 2 decimals to skip float noise)', () => {
    const sum = Object.values(BREAKDOWN_WEIGHTS).reduce((acc, weight) => acc + weight, 0)
    expect(Math.round(sum * 100) / 100).toBe(1.0)
  })

  it('a clean workflow with happy signals reaches the healthy threshold', () => {
    const result = computeWorkflowHealth({
      workflow: makeWorkflow({
        nodes: [{ id: 'start', type: 'noop', config: {} }, { id: 'gate', type: 'approval', config: {} }],
        outputs: { result: 'ok' },
      }),
      readiness: cleanReadiness,
      signals: {
        ...baseSignals,
        totalRuns: 30,
        successCount: 30,
        p95LatencyMs: 1_500,
        versionCount: 3,
      },
    })
    expect(result.status).toBe('healthy')
    expect(result.score).toBeGreaterThanOrEqual(80)
  })

  it('score drops below the warn threshold when failures pile up', () => {
    const result = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: {
        status: 'fail',
        issues: [
          { code: 'external_node_missing_retry', severity: 'fail', message: 'no retry' },
          { code: 'raw_secret_in_config', severity: 'fail', message: 'leak' },
        ],
      },
      signals: { ...baseSignals, totalRuns: 30, successCount: 10, failureCount: 20, dlqOpenCount: 4 },
    })
    expect(result.status).toBe('unhealthy')
    expect(result.score).toBeLessThan(60)
  })

  it('score recovers after fixing readiness blockers (AC: changes after added approval gates / missing timeouts)', () => {
    const before = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: {
        status: 'fail',
        issues: [
          { code: 'external_node_missing_retry', severity: 'fail', message: 'no retry' },
          { code: 'http_missing_bounds', severity: 'warn', message: 'no bounds' },
        ],
      },
      signals: { ...baseSignals, totalRuns: 20, successCount: 19 },
    })
    const after = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 20, successCount: 19 },
    })
    expect(after.score).toBeGreaterThan(before.score)
  })

  it('score drops after failed runs (AC: changes after failed runs)', () => {
    const before = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 30, successCount: 30 },
    })
    const after = computeWorkflowHealth({
      workflow: noopWorkflow,
      readiness: cleanReadiness,
      signals: { ...baseSignals, totalRuns: 30, successCount: 18, failureCount: 12 },
    })
    expect(after.score).toBeLessThan(before.score)
  })
})
