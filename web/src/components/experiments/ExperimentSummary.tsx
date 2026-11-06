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

import React, { useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Clipboard, TriangleAlert } from 'lucide-react'

import { useT } from '../../i18n'
import { formatCurrency, formatDelta, formatPercent, formatScorePoints, parseSummary, type Experiment, type ExperimentSummary, type SideSummary } from './types'
import { Button } from '@/components/ui/Button'
import { SwitchField } from '@/components/ui/SwitchField'
import './experiments.css'

const ARMS = ['control', 'candidate'] as const
type Arm = typeof ARMS[number]

type Metric = {
  id: string
  label: string
  better: 'higher' | 'lower' | null
  read: (side: SideSummary) => number | null
  format: (value: number) => string
  // Failed examples add neither cost nor latency, so unequal coverage cannot be called better or worse.
  comparable: boolean
  flagNonZero?: boolean
}

function buildMetrics(summary: ExperimentSummary, t: ReturnType<typeof useT>['t']): Metric[] {
  const { control, candidate } = summary
  const count = (value: number) => String(value)
  return [
    { id: 'score', label: t('experiments.table.score'), better: 'higher', read: (side) => side.meanScore * 100, format: formatPercent, comparable: true },
    {
      id: 'cost',
      label: t('experiments.table.cost'),
      better: 'lower',
      read: (side) => side.costKnownCount > 0 ? side.totalCostUsd : null,
      format: formatCurrency,
      comparable: control.costKnownCount === candidate.costKnownCount,
    },
    {
      id: 'latency',
      label: t('experiments.table.latency'),
      better: 'lower',
      read: (side) => side.meanLatencyMs,
      format: (value) => t('experiments.metric.latency', { value: Math.round(value) }),
      comparable: control.errorCount === candidate.errorCount,
    },
    { id: 'errors', label: t('experiments.table.errors'), better: 'lower', read: (side) => side.errorCount, format: count, comparable: true, flagNonZero: true },
    { id: 'judged', label: t('experiments.table.judged'), better: null, read: (side) => side.judgedByLlmCount, format: count, comparable: true },
    { id: 'fallbacks', label: t('experiments.table.scoringFallbacks'), better: 'lower', read: (side) => side.scoringFallbackCount, format: count, comparable: true, flagNonZero: true },
  ]
}

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
  const [baseline, setBaseline] = useState<Arm>('control')
  const [diffOnly, setDiffOnly] = useState(false)
  const compared: Arm = baseline === 'control' ? 'candidate' : 'control'
  const unknown = t('common.unknown')
  const metrics = summary ? buildMetrics(summary, t).map((metric) => {
    const text = (arm: Arm) => {
      const value = metric.read(summary[arm])
      return value === null ? unknown : metric.format(value)
    }
    return { ...metric, text, changed: text('control') !== text('candidate') }
  }) : []
  const visibleMetrics = diffOnly ? metrics.filter((metric) => metric.changed) : metrics

  function renderDelta(metric: typeof metrics[number]): React.ReactNode {
    const from = metric.read(summary![baseline])
    const to = metric.read(summary![compared])
    if (!metric.changed || from === null || to === null) return null
    const delta = to - from
    const verdict = !metric.better || !metric.comparable ? null
      : (delta > 0) === (metric.better === 'higher') ? 'better' : 'worse'
    return (
      <span className="we-experiments__delta" data-testid={`experiment-delta-${metric.id}`} data-verdict={verdict ?? 'neutral'}>
        {formatDelta(delta, metric.format)}
        {verdict && <strong>{t(`experiments.compare.${verdict}`)}</strong>}
      </span>
    )
  }

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
          <SwitchField
            className="we-experiments__diff-only"
            data-testid="experiment-diff-only"
            label={t('experiments.compare.diffOnly')}
            checked={diffOnly}
            onChange={(event) => setDiffOnly(event.target.checked)}
          />
          <div className="we-experiments__table-wrap">
            <table className="we-experiments__table">
              <thead>
                <tr>
                  <th scope="col">{t('experiments.table.metric')}</th>
                  {ARMS.map((arm) => (
                    <th scope="col" key={arm}>
                      <span className="we-experiments__arm">
                        {t(`experiments.arm.${arm}`)}
                        <code>{arm === 'control' ? experiment.controlRef : experiment.candidateRef}</code>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className="we-experiments__baseline"
                        data-testid={`experiment-baseline-${arm}`}
                        data-baseline={baseline === arm}
                        onClick={() => setBaseline(arm)}
                      >
                        {t(baseline === arm ? 'experiments.compare.baseline' : 'experiments.compare.makeBaseline')}
                      </Button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleMetrics.map((metric) => {
                  const Direction = metric.better === 'higher' ? ArrowUpRight : ArrowDownRight
                  return (
                    <tr key={metric.id} data-testid={`experiment-metric-${metric.id}`}>
                      <th scope="row">
                        {metric.label}
                        {metric.better && (
                          <span className="we-experiments__direction" title={t(`experiments.compare.${metric.better}Better`)}>
                            <Direction size={12} aria-hidden="true" />
                            <span className="we-sr-only">{t(`experiments.compare.${metric.better}Better`)}</span>
                          </span>
                        )}
                      </th>
                      {ARMS.map((arm) => (
                        <td key={arm} data-severity={metric.flagNonZero && metric.read(summary[arm]) ? 'danger' : undefined}>
                          {metric.text(arm)}
                          {arm === compared && renderDelta(metric)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
                {visibleMetrics.length === 0 && (
                  <tr><td colSpan={3} className="helper-text">{t('experiments.compare.noDifferences')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {summary.control.errorCount !== summary.candidate.errorCount && (
            <p className="we-experiments__notice" data-testid="experiment-coverage-notice">
              <TriangleAlert size={14} aria-hidden="true" />
              {t('experiments.compare.coverageNotice', {
                controlDone: summary.exampleCount - summary.control.errorCount,
                candidateDone: summary.exampleCount - summary.candidate.errorCount,
                total: summary.exampleCount,
              })}
            </p>
          )}
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
