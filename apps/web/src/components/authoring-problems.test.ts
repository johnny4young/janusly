import { describe, expect, it } from 'vitest'
import { buildAuthoringProblems } from './authoring-problems'

describe('buildAuthoringProblems', () => {
  it('merges duplicate code/location findings and preserves every source', () => {
    const problems = buildAuthoringProblems({
      validationIssues: [{ code: 'condition_invalid_expression', message: 'bad expression', nodeId: 'gate' }],
      readiness: {
        status: 'fail',
        issues: [{ code: 'condition_invalid_expression', message: 'bad expression', severity: 'fail', nodeId: 'gate' }],
      },
      aiReviewIssues: [{
        code: 'unclear_branch',
        message: 'branch is unclear',
        severity: 'warn',
        nodeId: 'gate',
        rationale: 'Ambiguous outcome',
        suggestion: 'Use an explicit comparison',
      }],
    })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatchObject({ code: 'condition_invalid_expression', severity: 'fail' })
    expect(problems[0].sources).toEqual(['validation', 'readiness'])
    expect(problems[0].primarySource).toBe('validation')
    expect(problems[1]).toMatchObject({ code: 'unclear_branch', severity: 'warn', sources: ['aiReview'] })
  })

  it('sorts blockers before warnings and workflow-level findings last within a severity', () => {
    const problems = buildAuthoringProblems({
      validationIssues: [
        { code: 'workflow_bad', message: 'workflow', edgeId: 'z-edge' },
        { code: 'node_bad', message: 'node', nodeId: 'a-node' },
      ],
      readiness: { status: 'warn', issues: [{ code: 'warn', message: 'warn', severity: 'warn' }] },
      aiReviewIssues: [],
    })
    expect(problems.map((problem) => problem.code)).toEqual(['node_bad', 'workflow_bad', 'warn'])
  })

  it('canonicalizes server edge indexes before merging locations', () => {
    const problems = buildAuthoringProblems({
      validationIssues: [{ code: 'edge_invalid_condition', message: 'invalid', edgeId: 'edge_0' }],
      readiness: null,
      aiReviewIssues: [{
        code: 'edge_invalid_condition',
        message: 'reviewed',
        severity: 'warn',
        edgeId: 'e0',
        rationale: 'Ambiguous branch',
        suggestion: 'Use an explicit comparison',
      }],
      workflowEdges: [{ id: 'e0', source: 'first', target: 'second', data: {} }],
    })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ edgeId: 'e0', sources: ['validation', 'aiReview'] })
  })
})
