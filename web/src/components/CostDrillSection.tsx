import { Coins } from 'lucide-react'
import type { ReactNode } from 'react'

import { getResolvedLocale, useT } from '../i18n'
import type { UsageCosts } from '../lib/api-types.generated'
import { EmptyState } from './EmptyState'
import { Button } from './ui/Button'
import './SettingsUsageSection.css'
import './CostDrillSection.css'

type CostRow = UsageCosts['totals']

const RUN_ID_PREVIEW = 8

function estimatedCost(usd: number, locale: string): string {
  const amount = usd.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 })
  return `≈ ${amount}`
}

export function CostDrillSection({
  costs,
  stepsRead,
  selectedModel,
  onSelectModel,
  onOpenRun,
}: {
  costs: UsageCosts | null | undefined
  /** The read behind the steps table: `costs`, or the selected model's own. */
  stepsRead: UsageCosts | null | undefined
  selectedModel: string | null
  onSelectModel: (model: string | null) => void
  onOpenRun: (runId: string) => void
}) {
  const { t } = useT()
  const locale = getResolvedLocale()
  if (costs === null) return null
  if (costs === undefined) {
    return <section className="we-card we-cost-drill"><p className="helper-text">{t('common.loading')}</p></section>
  }

  const count = (value: number) => value.toLocaleString(locale)
  // A row with no priced call has no cost to state, which is not the same as $0.
  const costCell = (row: CostRow) => {
    if (row.costUsd !== null) return estimatedCost(row.costUsd, locale)
    return row.simulatedCalls > 0 ? t('activity.reports.cost.simulated') : '—'
  }
  const tokenCells = (row: CostRow): ReactNode => (
    <>
      <td>{count(row.uncachedInputTokens)}</td>
      <td>{count(row.cachedInputTokens)}</td>
      <td>{count(row.outputTokens)}</td>
      <td>{count(row.calls)}</td>
      <td>{costCell(row)}</td>
    </>
  )
  const tokenHeads = (
    <>
      <th>{t('activity.reports.cost.col.uncached')}</th>
      <th>{t('activity.reports.cost.col.cached')}</th>
      <th>{t('activity.reports.cost.col.output')}</th>
      <th>{t('activity.reports.cost.col.calls')}</th>
      <th>{t('activity.reports.cost.col.cost')}</th>
    </>
  )
  const { totals, withoutRun, windowDays } = costs
  const steps = stepsRead?.steps
  const shownModels = costs.models.length
  const heading = (
    <div className="we-cost-drill__head">
      <strong>{t('activity.reports.cost.title')}</strong>
      <span className="helper-text">{t('activity.reports.cost.window', { days: windowDays })}</span>
    </div>
  )

  if (totals.calls === 0) {
    return (
      <section className="we-card we-cost-drill" data-testid="cost-drill">
        {heading}
        <EmptyState
          icon={<Coins />}
          kicker={t('activity.reports.cost.empty.title')}
          body={t(costs.aiConfigured ? 'activity.reports.cost.empty.noCalls' : 'activity.reports.cost.empty.notConfigured', { days: windowDays })}
          testId="cost-drill-empty"
        />
      </section>
    )
  }

  const notes = [
    totals.unknownCostCalls > 0 && t('activity.reports.cost.note.unknown', { count: totals.unknownCostCalls }),
    totals.simulatedCalls > 0 && t('activity.reports.cost.note.simulated', { count: totals.simulatedCalls }),
    withoutRun.calls > 0 && t('activity.reports.cost.note.withoutRun', { count: withoutRun.calls }),
    costs.truncated && t('activity.reports.cost.note.truncated', { rows: count(costs.rowCap) }),
    costs.retentionDays > 0 && costs.retentionDays < windowDays && t('activity.reports.cost.note.retention', { days: costs.retentionDays }),
  ].filter((note) => typeof note === 'string')

  return (
    <section className="we-card we-cost-drill" data-testid="cost-drill">
      {heading}
      <dl className="we-ops-cache-summary we-cost-drill__summary" data-testid="cost-drill-summary">
        <div><dt>{t('activity.reports.cost.stat.cost')}</dt><dd>{costCell(totals)}</dd></div>
        <div><dt>{t('activity.reports.cost.col.calls')}</dt><dd>{count(totals.calls)}</dd></div>
        <div><dt>{t('activity.reports.cost.col.uncached')}</dt><dd>{count(totals.uncachedInputTokens)}</dd></div>
        <div><dt>{t('activity.reports.cost.col.cached')}</dt><dd>{count(totals.cachedInputTokens)}</dd></div>
        <div><dt>{t('activity.reports.cost.stat.cacheWrites')}</dt><dd>{count(totals.cacheCreationInputTokens)}</dd></div>
        <div><dt>{t('activity.reports.cost.col.output')}</dt><dd>{count(totals.outputTokens)}</dd></div>
      </dl>
      {notes.length > 0 && (
        <ul className="we-cost-drill__notes" data-testid="cost-drill-notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}

      <div className="we-cost-drill__head">
        <strong>{selectedModel
          ? t('activity.reports.cost.steps.titleForModel', { model: selectedModel })
          : t('activity.reports.cost.steps.title')}</strong>
        {selectedModel && (
          <Button size="sm" data-testid="cost-drill-clear-model" onClick={() => onSelectModel(null)}>
            {t('activity.reports.cost.steps.allModels')}
          </Button>
        )}
      </div>
      {stepsRead === undefined && <p className="helper-text">{t('common.loading')}</p>}
      {steps?.length === 0 && <p className="helper-text" data-testid="cost-drill-no-steps">{t('activity.reports.cost.steps.empty')}</p>}
      {steps && steps.length > 0 && (
        <div className="we-ops-cost-table-wrap" role="region" tabIndex={0} aria-label={t('activity.reports.cost.steps.title')} data-testid="cost-drill-steps">
          <table className="we-ops-cost-table">
            <thead>
              <tr>
                <th>{t('activity.reports.cost.col.run')}</th>
                <th>{t('activity.reports.cost.col.workflow')}</th>
                <th>{t('activity.reports.cost.col.step')}</th>
                <th>{t('activity.reports.cost.col.model')}</th>
                {tokenHeads}
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => {
                const shortId = step.runId.slice(0, RUN_ID_PREVIEW)
                return (
                  <tr key={`${step.runId}::${step.nodeId ?? ''}::${step.provider}::${step.model}`}>
                    <td>
                      {step.runAvailable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="cost-drill-open-run"
                          aria-label={t('activity.reports.cost.openRun', { id: shortId })}
                          onClick={() => onOpenRun(step.runId)}
                        >
                          <code>{shortId}</code>
                        </Button>
                      ) : (
                        <span title={t('activity.reports.cost.runPurged')}><code>{shortId}</code></span>
                      )}
                    </td>
                    <td>{step.workflowName || '—'}</td>
                    <td>{step.nodeId ? <code>{step.nodeId}</code> : t('activity.reports.cost.wholeRun')}</td>
                    <td><code>{step.model}</code></td>
                    {tokenCells(step)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {stepsRead && stepsRead.stepsTotal > stepsRead.steps.length && (
        <p className="helper-text" data-testid="cost-drill-steps-top">
          {t('activity.reports.cost.steps.top', { shown: stepsRead.steps.length, total: stepsRead.stepsTotal })}
        </p>
      )}

      <strong className="we-cost-drill__subhead">{t('activity.reports.cost.models.title')}</strong>
      <div className="we-ops-cost-table-wrap" role="region" tabIndex={0} aria-label={t('activity.reports.cost.models.title')} data-testid="cost-drill-models">
        <table className="we-ops-cost-table">
          <thead>
            <tr>
              <th>{t('activity.reports.cost.col.model')}</th>
              {tokenHeads}
              <th>{t('activity.reports.cost.col.steps')}</th>
            </tr>
          </thead>
          <tbody>
            {costs.models.map((row) => (
              <tr key={`${row.provider}::${row.model}`}>
                <td><code>{row.model}</code></td>
                {tokenCells(row)}
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={selectedModel === row.model}
                    data-testid="cost-drill-model-steps"
                    onClick={() => onSelectModel(selectedModel === row.model ? null : row.model)}
                  >
                    {t('activity.reports.cost.models.showSteps')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {costs.modelsTotal > shownModels && (
        <p className="helper-text" data-testid="cost-drill-models-top">
          {t('activity.reports.cost.models.top', { shown: shownModels, total: costs.modelsTotal })}
        </p>
      )}
    </section>
  )
}
