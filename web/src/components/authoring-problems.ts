/**
 * Pure projection for the Inspector Problems surface.
 *
 * Validation, deterministic readiness, and AI review can report the same
 * stable code/location. This merger collapses those duplicates, preserves all
 * provenances, and sorts by worst severity without persisting ephemeral rows.
 */

import type { AiReviewIssue, ReadinessResult, ValidationIssue, WorkflowGraphEdge } from '../types'

export type AuthoringProblemSource = 'validation' | 'readiness' | 'aiReview'
export type AuthoringProblemSeverity = 'info' | 'warn' | 'fail'

export type AuthoringProblem = {
  id: string
  code: string
  severity: AuthoringProblemSeverity
  message: string
  nodeId?: string
  edgeId?: string
  sources: AuthoringProblemSource[]
  primarySource: AuthoringProblemSource
  rationale?: string
  suggestion?: string
}

const severityRank: Record<AuthoringProblemSeverity, number> = { info: 0, warn: 1, fail: 2 }
const sourceRank: Record<AuthoringProblemSource, number> = { validation: 0, readiness: 1, aiReview: 2 }

function locationKey(issue: ValidationIssue): string {
  return `${issue.code}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}`
}

/** Server checks identify serialized edges as `edge_<index>` because the
 * workflow contract has no edge-id field. Resolve that stable index back to
 * the React Flow edge id so Problems can deduplicate and focus the live edge. */
export function resolveAuthoringProblemEdgeId(
  edgeId: string | undefined,
  workflowEdges: WorkflowGraphEdge[],
): string | undefined {
  if (!edgeId) return undefined
  if (workflowEdges.some((edge) => edge.id === edgeId)) return edgeId
  const match = /^edge_(\d+)$/.exec(edgeId)
  if (!match) return edgeId
  const index = Number(match[1])
  return workflowEdges[index]?.id ?? edgeId
}

function addProblem(
  target: Map<string, AuthoringProblem>,
  source: AuthoringProblemSource,
  issue: ValidationIssue & { severity?: AuthoringProblemSeverity; rationale?: string; suggestion?: string },
): void {
  const key = locationKey(issue)
  const severity = issue.severity ?? 'fail'
  const existing = target.get(key)
  if (!existing) {
    target.set(key, {
      id: key,
      code: issue.code,
      severity,
      message: issue.message,
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
      sources: [source],
      primarySource: source,
      rationale: issue.rationale,
      suggestion: issue.suggestion,
    })
    return
  }

  if (!existing.sources.includes(source)) existing.sources.push(source)
  if (severityRank[severity] > severityRank[existing.severity]) existing.severity = severity
  if (sourceRank[source] < sourceRank[existing.primarySource]) {
    existing.primarySource = source
    existing.message = issue.message
  }
  existing.rationale ??= issue.rationale
  existing.suggestion ??= issue.suggestion
}

export function buildAuthoringProblems({
  validationIssues,
  readiness,
  aiReviewIssues,
  workflowEdges = [],
}: {
  validationIssues: ValidationIssue[]
  readiness: ReadinessResult | null
  aiReviewIssues: AiReviewIssue[]
  workflowEdges?: WorkflowGraphEdge[]
}): AuthoringProblem[] {
  const merged = new Map<string, AuthoringProblem>()
  for (const issue of validationIssues) {
    addProblem(merged, 'validation', {
      ...issue,
      edgeId: resolveAuthoringProblemEdgeId(issue.edgeId, workflowEdges),
      severity: 'fail',
    })
  }
  for (const issue of readiness?.issues ?? []) {
    addProblem(merged, 'readiness', {
      ...issue,
      edgeId: resolveAuthoringProblemEdgeId(issue.edgeId, workflowEdges),
    })
  }
  for (const issue of aiReviewIssues) {
    addProblem(merged, 'aiReview', {
      ...issue,
      edgeId: resolveAuthoringProblemEdgeId(issue.edgeId, workflowEdges),
    })
  }

  return [...merged.values()].sort((a, b) => {
    const severity = severityRank[b.severity] - severityRank[a.severity]
    if (severity !== 0) return severity
    const locationA = a.nodeId ?? a.edgeId ?? ''
    const locationB = b.nodeId ?? b.edgeId ?? ''
    return locationA.localeCompare(locationB) || a.code.localeCompare(b.code)
  })
}
