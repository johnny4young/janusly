/**
 * Controlled-drill evidence summary for the Recovery Center.
 *
 * The API owns evidence derivation and denominators. This component only
 * localizes and formats the bounded report; it never infers recovery from a
 * replay status or claims that external private-beta criteria are complete.
 */

import { useState } from 'react'
import { ClipboardCheck, Download, FileText } from 'lucide-react'

import { downloadFromApi } from '../api'
import { getResolvedLocale, useT } from '../i18n'
import { formatDuration } from './recovery-center/recovery-center-model'

export type RecoveryValidationReport = {
  generatedAt: string
  windowDays: number
  sampleLimit: number
  sampleCapped: boolean
  totals: {
    drills: number
    completed: number
    recovered: number
    acceptedLoss: number
    awaitingAction: number
    replayInProgress: number
    measurementIncomplete: number
    missingEvidence: number
    completionRatePercent: number | null
    recoveryRatePercent: number | null
  }
  resolution: {
    operator: number
    automated: number
    unknown: number
    operatorInterventionRatePercent: number | null
  }
  timing: {
    medianElapsedMs: number | null
    p90ElapsedMs: number | null
    averageElapsedMs: number | null
    p95ElapsedMs: number | null
    sampleSize: number
  }
  byFailureMode: Array<{
    key: string
    total: number
    completed: number
    recovered: number
    acceptedLoss: number
    recoveryRatePercent: number | null
  }>
}

type RecoveryValidationSectionProps = {
  /** `undefined` while loading, `null` after a soft read failure. */
  report: RecoveryValidationReport | null | undefined
}

function formatPercent(value: number | null): string {
  if (value == null) return '—'
  try {
    return new Intl.NumberFormat(getResolvedLocale(), {
      maximumFractionDigits: 1,
      minimumFractionDigits: value % 1 === 0 ? 0 : 1,
    }).format(value) + '%'
  } catch {
    return `${value}%`
  }
}

function formatMeasuredDuration(value: number | null): string {
  return value == null ? '—' : formatDuration(value)
}

export function RecoveryValidationSection({ report }: RecoveryValidationSectionProps) {
  const { t } = useT()
  const [exporting, setExporting] = useState<'markdown' | 'json' | null>(null)

  const handleExport = async (format: 'markdown' | 'json') => {
    if (exporting) return
    setExporting(format)
    try {
      await downloadFromApi(`/reports/recovery-validation?windowDays=${report?.windowDays ?? 30}&format=${format}`)
    } finally {
      setExporting(null)
    }
  }

  const waiting = report === undefined
  const unavailable = report === null
  const empty = report?.totals.drills === 0
  const unresolved = report
    ? report.totals.awaitingAction
      + report.totals.replayInProgress
      + report.totals.measurementIncomplete
      + report.totals.missingEvidence
    : 0

  return (
    <section
      className="we-card we-recovery-validation"
      aria-labelledby="recovery-validation-heading"
      aria-busy={waiting}
      data-testid="recovery-validation-section"
    >
      <header className="we-recovery-validation__header">
        <div>
          <div className="section-kicker">{t('recoveryCenter.validation.kicker')}</div>
          <h2 id="recovery-validation-heading" className="we-recovery-validation__title">
            <ClipboardCheck size={18} aria-hidden="true" />
            {t('recoveryCenter.validation.title')}
          </h2>
          <p className="we-recovery-validation__subtitle">
            {t('recoveryCenter.validation.subtitle')}
          </p>
        </div>
        <div className="we-recovery-validation__actions">
          <button
            type="button"
            className="small-command"
            disabled={exporting !== null}
            onClick={() => void handleExport('markdown')}
          >
            <FileText size={14} aria-hidden="true" />
            {t('recoveryCenter.validation.export.markdown')}
          </button>
          <button
            type="button"
            className="small-command"
            disabled={exporting !== null}
            onClick={() => void handleExport('json')}
          >
            <Download size={14} aria-hidden="true" />
            {t('recoveryCenter.validation.export.json')}
          </button>
        </div>
      </header>

      {waiting && <p className="we-recovery-validation__state">{t('recoveryCenter.validation.loading')}</p>}
      {unavailable && <p className="we-recovery-validation__state">{t('recoveryCenter.validation.unavailable')}</p>}
      {empty && <p className="we-recovery-validation__state">{t('recoveryCenter.validation.empty')}</p>}

      {report && report.totals.drills > 0 && (
        <>
          <div className="we-recovery-validation__grid">
            <div className="we-recovery-validation__metric">
              <span>{t('recoveryCenter.validation.metric.completion')}</span>
              <strong>{report.totals.completed}/{report.totals.drills}</strong>
              <small>{formatPercent(report.totals.completionRatePercent)}</small>
            </div>
            <div className="we-recovery-validation__metric">
              <span>{t('recoveryCenter.validation.metric.recoveryRate')}</span>
              <strong>{formatPercent(report.totals.recoveryRatePercent)}</strong>
              <small>{t('recoveryCenter.validation.metric.completedDenominator')}</small>
            </div>
            <div className="we-recovery-validation__metric">
              <span>{t('recoveryCenter.validation.metric.operatorIntervention')}</span>
              <strong>{formatPercent(report.resolution.operatorInterventionRatePercent)}</strong>
              <small>{t('recoveryCenter.validation.metric.knownActors', {
                known: report.resolution.operator + report.resolution.automated,
                unknown: report.resolution.unknown,
              })}</small>
            </div>
            <div className="we-recovery-validation__metric">
              <span>{t('recoveryCenter.validation.metric.recoveryTime')}</span>
              <strong>{formatMeasuredDuration(report.timing.medianElapsedMs)}</strong>
              <small>{t('recoveryCenter.validation.metric.p90', {
                duration: formatMeasuredDuration(report.timing.p90ElapsedMs),
                count: report.timing.sampleSize,
              })}</small>
            </div>
          </div>

          <div className="we-recovery-validation__outcomes" aria-label={t('recoveryCenter.validation.outcomesAria')}>
            <span className="we-pill" data-tone="success">
              {t('recoveryCenter.validation.outcome.recovered', { count: report.totals.recovered })}
            </span>
            <span className="we-pill" data-tone="warning">
              {t('recoveryCenter.validation.outcome.acceptedLoss', { count: report.totals.acceptedLoss })}
            </span>
            <span className="we-pill" data-tone={unresolved > 0 ? 'danger' : 'neutral'}>
              {t('recoveryCenter.validation.outcome.unresolved', { count: unresolved })}
            </span>
            {report.sampleCapped && (
              <span className="we-pill" data-tone="neutral">
                {t('recoveryCenter.validation.sampleCapped', { limit: report.sampleLimit })}
              </span>
            )}
          </div>

          {report.byFailureMode.length > 0 && (
            <div className="we-recovery-validation__coverage">
              <span>{t('recoveryCenter.validation.coverage')}</span>
              <ul>
                {report.byFailureMode.slice(0, 6).map((entry) => (
                  <li key={entry.key}>
                    {t(`packs.drill.mode.${entry.key}`, { defaultValue: entry.key })}
                    <strong>{entry.total}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <p className="we-recovery-validation__boundary">
        {t('recoveryCenter.validation.boundary')}
      </p>
    </section>
  )
}
