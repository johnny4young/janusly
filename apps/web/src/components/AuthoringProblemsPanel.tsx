/** Consolidated, navigable workflow Problems surface for the Inspector. */

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import type { AiReviewIssue, ReadinessResult, ValidationIssue, WorkflowGraphEdge } from '../types'
import { tAiReviewIssue, tReadinessIssue, tValidationIssue, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { buildAuthoringProblems, type AuthoringProblem } from './authoring-problems'
import { requestAuthoringFocus } from './authoring-focus-bus'
import { requestResilienceFocus } from './resilience-focus-bus'

const resilienceIssueCodes = new Set(['external_node_missing_retry', 'http_missing_bounds'])

function localizeProblem(problem: AuthoringProblem): string {
  const issue = {
    code: problem.code,
    severity: problem.severity,
    message: problem.message,
    nodeId: problem.nodeId,
    edgeId: problem.edgeId,
    rationale: problem.rationale,
    suggestion: problem.suggestion,
  }
  if (problem.primarySource === 'validation') return tValidationIssue(issue)
  if (problem.primarySource === 'readiness') return tReadinessIssue(issue)
  return tAiReviewIssue(issue)
}

export function AuthoringProblemsPanel({
  validationIssues,
  readiness,
  aiReviewIssues,
  workflowEdges,
  onValidate,
}: {
  validationIssues: ValidationIssue[]
  readiness: ReadinessResult | null
  aiReviewIssues: AiReviewIssue[]
  workflowEdges: WorkflowGraphEdge[]
  onValidate(): Promise<boolean>
}) {
  const { t } = useT()
  const selectNode = useWorkflowStore((state) => state.selectNode)
  const selectEdge = useWorkflowStore((state) => state.selectEdge)
  const setActiveTab = useWorkflowStore((state) => state.setActiveTab)
  const [checking, setChecking] = useState(false)
  const problems = useMemo(
    () => buildAuthoringProblems({ validationIssues, readiness, aiReviewIssues, workflowEdges }),
    [aiReviewIssues, readiness, validationIssues, workflowEdges],
  )

  const openProblem = (problem: AuthoringProblem) => {
    if (problem.nodeId) {
      if (resilienceIssueCodes.has(problem.code)) requestResilienceFocus(problem.nodeId)
      else requestAuthoringFocus({ kind: 'node', id: problem.nodeId })
      selectNode(problem.nodeId)
      setActiveTab('inspector')
      return
    }
    if (problem.edgeId) {
      requestAuthoringFocus({ kind: 'edge', id: problem.edgeId })
      selectEdge(problem.edgeId)
      setActiveTab('inspector')
    }
  }

  const runValidation = async () => {
    setChecking(true)
    try {
      await onValidate()
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="panel-card we-authoring-problems" data-testid="authoring-problems" aria-labelledby="authoring-problems-heading">
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('problems.kicker')}</div>
          <h3 id="authoring-problems-heading">{t('problems.title')}</h3>
          <p className="helper-text">{t('problems.description')}</p>
        </div>
        <button
          type="button"
          className="small-command"
          onClick={() => { void runValidation() }}
          disabled={checking}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {checking ? t('problems.checking') : t('problems.check')}
        </button>
      </div>

      {problems.length === 0 ? (
        <div className="we-authoring-problems__empty" data-testid="authoring-problems-empty">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{readiness ? t('problems.empty') : t('problems.loading')}</span>
        </div>
      ) : (
        <ol className="we-authoring-problems__list">
          {problems.map((problem) => {
            const location = problem.nodeId ?? problem.edgeId
            const locatable = Boolean(location)
            const content = (
              <>
                <span className="we-authoring-problems__severity" data-severity={problem.severity}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  {t(`problems.severity.${problem.severity}` as never)}
                </span>
                <span className="we-authoring-problems__message">{localizeProblem(problem)}</span>
                <span className="we-authoring-problems__meta">
                  {problem.sources.map((source) => t(`problems.source.${source}` as never)).join(' · ')}
                  {location ? ` · ${location}` : ''}
                </span>
                {locatable && <ExternalLink className="we-authoring-problems__open" size={13} aria-hidden="true" />}
              </>
            )
            return (
              <li key={problem.id} data-severity={problem.severity}>
                {locatable ? (
                  <button
                    type="button"
                    className="we-authoring-problems__row"
                    onClick={() => openProblem(problem)}
                    aria-label={t(problem.nodeId ? 'problems.openNode' : 'problems.openEdge', { id: location })}
                    data-testid={`authoring-problem-${problem.code}`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="we-authoring-problems__row">{content}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
