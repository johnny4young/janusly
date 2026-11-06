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
import { formatCurrency, formatDelta, formatList, formatPercent, formatScorePoints, MIN_SCORE_DELTA, parseSummary, type Experiment, type ExperimentSummary, type SideSummary } from './types'
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
  // Display precision: changes are taken between the rounded values each arm shows.
  digits: number
  format: (value: number) => string
  comparable: boolean
  // A change smaller than the recommendation's noise floor gets no verdict.
  belowNoise?: boolean
  flagNonZero?: boolean
}

function buildMetrics(summary: ExperimentSummary, t: ReturnType<typeof useT>['t']): Metric[] {
  const { control, candidate } = summary
  const count = (value: number) => String(value)
  // A failed judge scores by token overlap and records no judge latency.
  const judgeFellBack = summary.recommendationReasonCode === 'scoring_fallback'
    || (summary.scorerKind === 'llm_judge' && (control.scoringFallbackCount > 0 || candidate.scoringFallbackCount > 0))
  // Failed examples add neither cost nor latency.
  const sameCoverage = control.errorCount === candidate.errorCount
  return [
    {
      id: 'score',
      label: t('experiments.table.score'),
      better: 'higher',
      read: (side) => side.meanScore * 100,
      digits: 1,
      format: formatPercent,
      comparable: !judgeFellBack,
      belowNoise: Math.abs(candidate.meanScore - control.meanScore) < MIN_SCORE_DELTA,
    },
    {
      id: 'cost',
      label: t('experiments.table.cost'),
      better: 'lower',
      read: (side) => side.costKnownCount > 0 ? side.totalCostUsd : null,
      digits: 4,
      format: formatCurrency,
      comparable: control.costKnownCount === candidate.costKnownCount,
    },
    {
      id: 'latency',
      label: t('experiments.table.latency'),
      better: 'lower',
      read: (side) => side.meanLatencyMs,
      digits: 0,
      format: (value) => t('experiments.metric.latency', { value }),
      comparable: sameCoverage && !judgeFellBack,
    },
    { id: 'errors', label: t('experiments.table.errors'), better: 'lower', read: (side) => side.errorCount, digits: 0, format: count, comparable: true, flagNonZero: true },
    { id: 'judged', label: t('experiments.table.judged'), better: null, read: (side) => side.judgedByLlmCount, digits: 0, format: count, comparable: true },
    { id: 'fallbacks', label: t('experiments.table.scoringFallbacks'), better: 'lower', read: (side) => side.scoringFallbackCount, digits: 0, format: count, comparable: true, flagNonZero: true },
  ]
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
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
    const shown = (arm: Arm) => {
      const value = metric.read(summary[arm])
      return value === null ? null : roundTo(value, metric.digits)
    }
    const text = (arm: Arm) => {
      const value = shown(arm)
      return value === null ? unknown : metric.format(value)
    }
    return { ...metric, shown, text, changed: text('control') !== text('candidate') }
  }) : []
  const withheld = metrics.filter((metric) => metric.better && !metric.comparable).map((metric) => metric.label)
  const visibleMetrics = diffOnly ? metrics.filter((metric) => metric.changed) : metrics

  function renderDelta(metric: typeof metrics[number]): React.ReactNode {
    const from = metric.shown(baseline)
    const to = metric.shown(compared)
    if (from === null || to === null) return null
    const delta = roundTo(to - from, metric.digits)
    if (delta === 0) return null
    const verdict = !metric.better || !metric.comparable || metric.belowNoise ? null
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
                        aria-pressed={baseline === arm}
                        aria-disabled={baseline === arm || undefined}
                        onClick={() => setBaseline(arm)}
                      >
                        {t(baseline === arm ? 'experiments.compare.baseline' : 'experiments.compare.makeBaseline')}
                        <span className="we-sr-only">{`: ${t(`experiments.arm.${arm}`)}`}</span>
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
          {withheld.length > 0 && (
            <p className="we-experiments__notice" data-testid="experiment-coverage-notice">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {summary.control.errorCount !== summary.candidate.errorCount && `${t('experiments.compare.coverage', {
                  controlDone: summary.exampleCount - summary.control.errorCount,
                  candidateDone: summary.exampleCount - summary.candidate.errorCount,
                  total: summary.exampleCount,
                })} `}
                {summary.control.costKnownCount !== summary.candidate.costKnownCount && `${t('experiments.compare.costCoverage', {
                  control: summary.control.costKnownCount,
                  candidate: summary.candidate.costKnownCount,
                })} `}
                {!metrics[0]!.comparable && `${t('experiments.compare.judgeFallback')} `}
                {t('experiments.compare.withheld', { metrics: formatList(withheld) })}
              </span>
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
