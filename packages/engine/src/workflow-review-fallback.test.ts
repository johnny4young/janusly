import { describe, expect, it } from 'vitest'
import type { Workflow } from '@janusly/shared'
import {
  buildReviewFallback,
  mergeReviewFindings,
  sanitizeAiReview,
  type ReviewFindings,
} from './workflow-review-fallback'

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    dslVersion: '1.0',
    nodes: [],
    edges: [],
    ...partial,
  } as Workflow
}

describe('buildReviewFallback', () => {
  it('returns status "pass" with no issues for a clean workflow', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'noop', type: 'noop', config: {} }],
      outputs: { result: '{{context.noop.output}}' },
    })
    const review = buildReviewFallback(workflow)
    expect(review.status).toBe('pass')
    expect(review.issues).toEqual([])
  })

  it('maps readiness fail-level issues into review findings with the deterministic rationale', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com', method: 'GET' } }],
    })
    const review = buildReviewFallback(workflow)
    expect(review.status).toBe('fail')
    const retryFinding = review.issues.find((issue) => issue.code === 'external_node_missing_retry')
    expect(retryFinding).toBeDefined()
    expect(retryFinding!.severity).toBe('fail')
    expect(retryFinding!.rationale).toMatch(/Local rules-only review/)
    expect(retryFinding!.suggestion).toMatch(/maxAttempts/)
  })

  it('preserves the raw_secret_in_config code path through the fallback', () => {
    const workflow = makeWorkflow({
      nodes: [{
        id: 'fetch',
        type: 'http',
        config: {
          url: 'https://api.example.com',
          method: 'GET',
          timeoutMs: 5000,
          retry: { maxAttempts: 3 },
          headers: { Authorization: 'Bearer literal-leaky-token' },
        },
      }],
    })
    const review = buildReviewFallback(workflow)
    expect(review.issues.some((issue) => issue.code === 'raw_secret_in_config' && issue.severity === 'fail')).toBe(true)
  })

  it('includes structural validation failures such as malformed router candidates', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'missing_path' }] } },
        { id: 'known_path', type: 'noop', config: {} },
      ],
      edges: [{ from: 'start', to: 'pick' }],
      outputs: { result: '{{context.known_path.output}}' },
    })
    const review = buildReviewFallback(workflow)
    const routerFinding = review.issues.find((issue) => issue.code === 'router_candidate_unknown_node_id')
    expect(review.status).toBe('fail')
    expect(routerFinding).toBeDefined()
    expect(routerFinding!.severity).toBe('fail')
    expect(routerFinding!.nodeId).toBe('pick')
  })
})

describe('mergeReviewFindings', () => {
  it('appends deterministic blockers when the AI review omits them', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'start', type: 'noop', config: {} },
        { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'missing_path' }] } },
      ],
      edges: [{ from: 'start', to: 'pick' }],
      outputs: { result: '{{context.pick.output}}' },
    })
    const merged = mergeReviewFindings(
      { status: 'pass', issues: [] },
      buildReviewFallback(workflow),
    )
    expect(merged.status).toBe('fail')
    expect(merged.issues.some((issue) => issue.code === 'router_candidate_unknown_node_id')).toBe(true)
  })
})

describe('sanitizeAiReview', () => {
  const workflow = makeWorkflow({
    nodes: [
      { id: 'start', type: 'noop', config: {} },
      { id: 'pick', type: 'router', config: { candidates: [{ nodeId: 'fast' }] } },
      { id: 'fast', type: 'noop', config: {} },
    ],
    edges: [{ id: 'edge_main', from: 'start', to: 'pick' }],
  })

  it('keeps locatable findings and drops findings whose nodeId does not resolve', () => {
    const review: ReviewFindings = {
      status: 'fail',
      issues: [
        { code: 'real_finding', severity: 'fail', message: 'real', nodeId: 'pick', rationale: 'r', suggestion: 's' },
        { code: 'ghost_finding', severity: 'fail', message: 'ghost', nodeId: 'phantom', rationale: 'r', suggestion: 's' },
        { code: 'workflow_level', severity: 'warn', message: 'top', rationale: 'r', suggestion: 's' },
      ],
    }
    const sanitized = sanitizeAiReview(review, workflow)
    expect(sanitized.issues.map((issue) => issue.code)).toEqual(['real_finding', 'workflow_level'])
    // Status re-rolls based only on surviving findings — `real_finding` is
    // fail so the rollup stays fail.
    expect(sanitized.status).toBe('fail')
  })

  it('drops findings whose edgeId does not resolve and re-rolls status downward', () => {
    const review: ReviewFindings = {
      status: 'fail',
      issues: [
        { code: 'edge_finding', severity: 'fail', message: 'fail', edgeId: 'edge_phantom', rationale: 'r', suggestion: 's' },
        { code: 'edge_real', severity: 'warn', message: 'warn', edgeId: 'edge_main', rationale: 'r', suggestion: 's' },
      ],
    }
    const sanitized = sanitizeAiReview(review, workflow)
    expect(sanitized.issues.map((issue) => issue.code)).toEqual(['edge_real'])
    // Only the surviving warn remains, so the rollup softens from fail → warn.
    expect(sanitized.status).toBe('warn')
  })
})
