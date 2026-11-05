/** Consolidated, navigable workflow Problems surface for the Inspector. */

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import type { AiReviewIssue, ReadinessResult, ValidationIssue, WorkflowGraphEdge } from '../types'
import { useT } from '../i18n'
import { buildAuthoringProblems, localizeAuthoringProblem } from './authoring-problems'
import { hasAuthoringProblemTarget, openAuthoringProblem } from './open-authoring-problem'
import { Button } from './ui/Button'

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
  const [checking, setChecking] = useState(false)
  const problems = useMemo(
    () => buildAuthoringProblems({ validationIssues, readiness, aiReviewIssues, workflowEdges }),
    [aiReviewIssues, readiness, validationIssues, workflowEdges],
  )

  const runValidation = async () => {
    setChecking(true)
    try {
      await onValidate()
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="we-card we-authoring-problems" data-testid="authoring-problems" aria-labelledby="authoring-problems-heading">
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('problems.kicker')}</div>
          <h3 id="authoring-problems-heading">{t('problems.title')}</h3>
          <p className="helper-text">{t('problems.description')}</p>
        </div>
        <Button
          size="sm"
         
         
          onClick={() => { void runValidation() }}
          disabled={checking}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {checking ? t('problems.checking') : t('problems.check')}
        </Button>
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
            const locatable = hasAuthoringProblemTarget(problem)
            const content = (
              <>
                <span className="we-authoring-problems__severity" data-severity={problem.severity}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  {t(`problems.severity.${problem.severity}`)}
                </span>
                <span className="we-authoring-problems__message">{localizeAuthoringProblem(problem)}</span>
                <span className="we-authoring-problems__meta">
                  {problem.sources.map((source) => t(`problems.source.${source}`)).join(' · ')}
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
                    onClick={() => openAuthoringProblem(problem)}
                    aria-label={location ? t(problem.nodeId ? 'problems.openNode' : 'problems.openEdge', { id: location }) : undefined}
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
