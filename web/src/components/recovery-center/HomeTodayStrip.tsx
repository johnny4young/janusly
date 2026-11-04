import { ArrowRight } from 'lucide-react'
import { getResolvedLocale, useT } from '../../i18n'
import { Button } from '../ui/Button'
import type { RunsToday } from './recovery-center-model'

export function HomeTodayStrip({
  runsToday,
  openFailures,
  approvals,
  onOpenRecoveryQueue,
  onOpenRuns,
  onOpenReports,
}: {
  /** `null` when this operator cannot read runs, or before the clock is known. */
  runsToday: RunsToday | null
  openFailures: number
  approvals: number
  onOpenRecoveryQueue: () => void
  onOpenRuns: () => void
  onOpenReports: () => void
}) {
  const { t } = useT()
  const percent = new Intl.NumberFormat(getResolvedLocale(), { style: 'percent', maximumFractionDigits: 1 })
  return (
    <section className="we-home-today we-card" aria-labelledby="we-home-today-title" data-testid="home-today">
      <header className="we-home-section-head">
        <h2 id="we-home-today-title">{t('home.today.title')}</h2>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onOpenReports}
          trailingIcon={<ArrowRight size={14} />}
          data-testid="home-today-open-reports"
        >
          {t('workspace.section.reports.label')}
        </Button>
      </header>
      <div className="we-home-today__cells">
        {runsToday && (
          <>
            <div className="we-home-today__cell" data-testid="home-today-runs">
              <span>{t('home.today.runs')}</span>
              <b>{runsToday.count}{runsToday.capped ? '+' : ''}</b>
            </div>
            <div className="we-home-today__cell" data-testid="home-today-success">
              <span>{t('home.today.success')}</span>
              <b>{runsToday.successRatio === null ? '—' : percent.format(runsToday.successRatio)}</b>
            </div>
          </>
        )}
        <button
          type="button"
          className="we-home-today__cell"
          data-attention={openFailures > 0 || undefined}
          onClick={onOpenRecoveryQueue}
          data-testid="recovery-center-metric-failures"
        >
          <span>{t('recoveryCenter.metric.failures.label')}</span>
          <b>{openFailures}</b>
        </button>
        <button
          type="button"
          className="we-home-today__cell"
          data-attention={approvals > 0 || undefined}
          onClick={onOpenRuns}
          data-testid="recovery-center-metric-approvals"
        >
          <span>{t('recoveryCenter.metric.approvals.label')}</span>
          <b>{approvals}</b>
        </button>
      </div>
    </section>
  )
}
