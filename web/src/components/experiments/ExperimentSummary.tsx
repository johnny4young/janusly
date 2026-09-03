/**
 * Selected experiment aggregate metrics and recommendation card.
 *
 * Used by:
 * - `ExperimentsPanel.tsx` — renders details after a history-row selection.
 *
 * Invariants:
 * - Recommendations remain advisory. The only action copies a reference for
 *   deliberate manual review; no prompt or organization state is mutated.
 */

import React from 'react'
import { Clipboard } from 'lucide-react'

import { useT } from '../../i18n'
import { formatCurrency, formatDelta, formatPercent, formatScorePoints, parseSummary, type Experiment, type ExperimentSummary } from './types'
import { Button } from '@/components/ui/Button'

function getRecommendationReason(summary: ExperimentSummary, t: ReturnType<typeof useT>['t']): string {
  // Derive a code for summaries persisted before the API exposed reason codes.
  const reasonCode = summary.recommendationReasonCode ?? (
    summary.recommendation === 'promote_candidate'
      ? 'candidate_score_improved'
      : summary.recommendation === 'keep_control'
        ? summary.scoreDelta < 0 ? 'control_score_improved' : 'within_noise'
        : null
  )
  return t(
    `experiments.recommendation.${reasonCode ? `reason.${reasonCode}` : 'inconclusive.reason'}`,
    { value: formatScorePoints(Math.abs(summary.scoreDelta * 100)) },
  )
}

export function ExperimentSummaryDetail({
  experiment,
  onCopyCandidate,
}: {
  experiment: Experiment
  onCopyCandidate: () => void
}): React.ReactElement {
  const { t } = useT()
  const summary = parseSummary(experiment.summary)

  return (
    <section className="we-card we-experiments__detail" aria-labelledby="experiment-detail-title" data-testid="experiment-detail">
      <div className="we-card__header">
        <div>
          <div className="section-kicker">{t('experiments.detail.kicker')}</div>
          <h3 id="experiment-detail-title">{experiment.name}</h3>
        </div>
        <span className="we-pill" data-tone="info">{t(`experiments.status.${experiment.status}`)}</span>
      </div>
      {summary ? (
        <>
          <p className="helper-text">{t('experiments.detail.summary', { count: summary.exampleCount, scorer: summary.scorerKind })}</p>
          <div className="we-experiments__table-wrap">
            <table className="we-experiments__table">
              <thead>
                <tr>
                  <th scope="col">{t('experiments.table.arm')}</th>
                  <th scope="col">{t('experiments.table.score')}</th>
                  <th scope="col">{t('experiments.table.cost')}</th>
                  <th scope="col">{t('experiments.table.latency')}</th>
                  <th scope="col">{t('experiments.table.errors')}</th>
                  <th scope="col">{t('experiments.table.judged')}</th>
                  <th scope="col">{t('experiments.table.scoringFallbacks')}</th>
                </tr>
              </thead>
              <tbody>
                {(['control', 'candidate'] as const).map((side) => {
                  const sideSummary = summary[side]
                  return (
                    <tr key={side}>
                      <th scope="row">{t(`experiments.arm.${side}`)}</th>
                      <td>{formatPercent(sideSummary.meanScore * 100)}</td>
                      <td>{sideSummary.costKnownCount > 0 ? formatCurrency(sideSummary.totalCostUsd) : t('experiments.metric.unknown')}</td>
                      <td>{t('experiments.metric.latency', { value: Math.round(sideSummary.meanLatencyMs) })}</td>
                      <td data-severity={sideSummary.errorCount > 0 ? 'danger' : 'healthy'}>{sideSummary.errorCount}</td>
                      <td>{sideSummary.judgedByLlmCount}</td>
                      <td data-severity={sideSummary.scoringFallbackCount > 0 ? 'danger' : 'healthy'}>{sideSummary.scoringFallbackCount}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <dl className="we-experiments__deltas">
            <div><dt>{t('experiments.metric.scoreDelta')}</dt><dd>{formatDelta(summary.scoreDelta * 100, formatPercent)}</dd></div>
            <div><dt>{t('experiments.metric.costDelta')}</dt><dd>{formatDelta(summary.costDelta, formatCurrency)}</dd></div>
          </dl>
          <aside className="we-experiments__recommendation" data-recommendation={summary.recommendation} aria-live="polite">
            <strong>{t(`experiments.recommendation.${summary.recommendation}.title`)}</strong>
            <p>{getRecommendationReason(summary, t)}</p>
            {summary.recommendation === 'promote_candidate' && (
              <>
                <p>{t('experiments.recommendation.promote_candidate.manual')}</p>
                <code>{experiment.candidateRef}</code>
                <Button variant="ghost" type="button"  onClick={onCopyCandidate}>
                  <Clipboard size={14} aria-hidden="true" />
                  {t('experiments.action.copyCandidate')}
                </Button>
              </>
            )}
          </aside>
        </>
      ) : (
        <p className="helper-text">{t('experiments.detail.noSummary')}</p>
      )}
    </section>
  )
}
