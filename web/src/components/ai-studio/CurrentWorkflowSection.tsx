import { CheckCircle2, ShieldCheck, Wrench } from 'lucide-react'
import { formatAiModeLabel } from '../../constants'
import { tAiReviewIssue, useT } from '../../i18n'
import { Button } from '../ui/Button'
import { FormActions } from '../ui/Form'
import { StatusSummary } from '../ui/StatusSummary'
import { CostEstimateChip } from './CostEstimateChip'
import { MODE_COPY_KEYS, describeAiError, reviewSummary } from './model'
import type { AiStudioModel } from './useAiStudioController'

// Explain / review / fix for the workflow on the canvas, and the live
// region that announces their results.
export function CurrentWorkflowSection({ model }: { model: AiStudioModel }) {
  const { t } = useT()
  const {
    health,
    workflowName,
    currentLoading,
    explain,
    review,
    fix,
    result,
    onApplyWorkflowImprovement,
  } = model
  return (
    <>
      <section className="we-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.current.heading')}</div>
            <strong>{workflowName}</strong>
          </div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
            {health?.enabled ? health.model : t('aiStudio.localRules')}
          </span>
        </div>
        <p className="helper-text">{t('aiStudio.current.body')}</p>
        <FormActions>
          <Button
            leadingIcon={<CheckCircle2 size={16} />}
            loading={currentLoading === 'explain'}
            loadingLabel={t('aiStudio.explaining')}
            disabled={currentLoading !== null}
            onClick={() => { void explain() }}
            trailingIcon={<CostEstimateChip action="explain" model={health?.model} />}
          >
            {t('aiStudio.explain')}
          </Button>
          <Button
            leadingIcon={<ShieldCheck size={16} />}
            loading={currentLoading === 'review'}
            loadingLabel={t('aiStudio.reviewing')}
            disabled={currentLoading !== null}
            onClick={() => { void review() }}
            trailingIcon={<CostEstimateChip action="review" model={health?.model} />}
          >
            {t('aiStudio.review')}
          </Button>
          <Button
            leadingIcon={<Wrench size={16} />}
            loading={currentLoading === 'fix'}
            loadingLabel={t('aiStudio.fixing')}
            disabled={currentLoading !== null}
            onClick={() => { void fix() }}
            trailingIcon={<CostEstimateChip action="fix" model={health?.model} />}
          >
            {t('aiStudio.fix')}
          </Button>
        </FormActions>
      </section>

      {/* Persistently mounted so assistive technology announces async results. */}
      <div className="ai-ai-studio__results" aria-live="polite">
        {result?.kind === 'explanation' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            {result.mode === 'fallback' && (
              <StatusSummary
                role="status"
                tone="info"
                title={t('aiStudio.fallbackBannerTitle')}
                description={t('aiStudio.fallbackBannerBody')}
              />
            )}
            <p className="helper-text">{t(MODE_COPY_KEYS[result.mode])}</p>
            <div className="result-body">{result.body}</div>
            {result.aiError && (
              <StatusSummary
                role="status"
                tone="warning"
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(t, result.aiError)}
              />
            )}
          </section>
        )}

        {result?.kind === 'review' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            <p className="helper-text">{reviewSummary(t, result.review, result.mode)}</p>
            {result.aiError && (
              <StatusSummary
                role="status"
                tone={result.mode === 'error' ? 'danger' : 'warning'}
                title={result.mode === 'error' ? t('aiStudio.reviewErrorTitle') : t('aiStudio.reviewFallbackTitle')}
                description={describeAiError(t, result.aiError)}
              />
            )}
            {result.review.issues.length > 0 && (
              <ul className="we-readiness-badge__issues ai-review-issues">
                {result.review.issues.map((issue, index) => (
                  <li key={[issue.code, index].join('-')} className={'we-readiness-issue we-readiness-issue--' + (issue.severity === 'info' ? 'warn' : issue.severity)}>
                    <strong className="we-readiness-issue__code">{issue.code}</strong>
                    {issue.nodeId && <span className="we-readiness-issue__node"> · {issue.nodeId}</span>}
                    {issue.edgeId && <span className="we-readiness-issue__node"> · {issue.edgeId}</span>}
                    <p className="we-readiness-issue__message">{tAiReviewIssue(issue)}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewWhy', { rationale: issue.rationale })}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewFix', { suggestion: issue.suggestion })}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {result?.kind === 'fix' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            {result.suggestions.length > 0 ? (
              <div className="ai-fix-list">
                {result.suggestions.map((suggestion, index) => (
                  <article className="ai-fix-card" key={[suggestion.approachLabel, index].join('-')}>
                    <div className="split-row">
                      <strong>{suggestion.approachLabel}</strong>
                      <span className="mode-pill mode-pill-neutral">
                        {t('aiStudio.fixConfidence', { percent: Math.round(suggestion.confidence * 100) })}
                      </span>
                    </div>
                    <p>{suggestion.rationale}</p>
                    <Button
                      size="sm"
                      variant="primary"
                      leadingIcon={<Wrench size={13} />}
                      onClick={() => { void onApplyWorkflowImprovement(suggestion) }}
                    >
                      {t('aiStudio.fixApply')}
                    </Button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="helper-text">{t('aiStudio.fixNoSuggestion')}</p>
            )}
            {result.aiError && (
              <StatusSummary
                role="status"
                tone={result.mode === 'error' ? 'danger' : 'warning'}
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(t, result.aiError)}
              />
            )}
          </section>
        )}
      </div>
    </>
  )
}
