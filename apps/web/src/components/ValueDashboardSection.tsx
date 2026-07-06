/**
 * Value Dashboard — the commercial-pitch surface that sits inside the
 * Recovery Center. Renders MTTR before/after, clusters resolved,
 * estimated hours saved, and estimated dollar savings.
 *
 * Every dollar/hour surface carries an "estimate" badge + tooltip
 * pointing at the org-config assumptions. The Markdown export
 * (downloaded via `/reports/value-dashboard?format=markdown`) writes
 * the formula out plainly so a CFO reading the artefact knows exactly
 * how the numbers were derived.
 *
 * The dashboard degrades gracefully when the org hasn't measured a
 * pre-Janusly MTTR baseline yet (the `value.baselineMttrSeconds`
 * sentinel is `0`). In that case the "Before" slot renders
 * "Awaiting private-beta data" with a link to the assumptions config —
 * the dashboard ships before the private-beta MTTR experiment closes.
 */

import React, { useState } from 'react'
import { Award, Download, FileText } from 'lucide-react'

import { downloadFromApi } from '../api'
import { getResolvedLocale, useT } from '../i18n'

export type ClustersResolvedMetric = {
  value: number | null
  display: string
  severity: 'healthy' | 'warn' | 'unhealthy' | 'neutral'
  rationale: string
  totalEntries: number
  capped: boolean
}

export type ValueEstimate = {
  hoursSaved: number
  dollarSaved: number
  mttrDeltaSeconds: number | null
  assumptions: {
    hourlyCost: number
    minutesSavedPerRecovery: number
    baselineMttrSeconds: number
  }
}

export type ValueDashboardSectionProps = {
  mttrMs: number | null
  mttrDisplay: string
  clustersResolved?: ClustersResolvedMetric
  valueEstimate?: ValueEstimate
  windowDays: number
  /** Total automation downtime CLOSED in the window (ms) — a measured figure, no estimate badge. */
  downtimeEndedMs?: number
  /** When true, the section renders the private-beta-pending empty state. */
  terminalRunsZero: boolean
}

/** Compact hours/minutes for the "downtime ended" figure: "3h 12m" / "45m" / "0m". */
function formatDurationHm(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalMinutes = Math.round(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

function formatCurrency(amount: number): string {
  try {
    return new Intl.NumberFormat(getResolvedLocale(), {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    // Fallback if the locale doesn't resolve cleanly. The `Intl` API is
    // standardised in Node 18+ + every modern browser, so this branch
    // is genuinely defensive.
    return `$${amount.toFixed(2)}`
  }
}

function formatHours(hours: number): string {
  // Round to 2 decimals but drop trailing zeros — "0.5h" / "12h", not
  // "0.50h" / "12.00h". The figure is already an estimate; false precision
  // hurts readability.
  return String(Number(hours.toFixed(2)))
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const rem = seconds % 60
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`
}

export function ValueDashboardSection(props: ValueDashboardSectionProps) {
  const { t } = useT()
  const { clustersResolved, valueEstimate, terminalRunsZero, windowDays } = props
  const [exporting, setExporting] = useState<'markdown' | 'json' | null>(null)

  const baselineMttrSeconds = valueEstimate?.assumptions.baselineMttrSeconds ?? 0
  const baselineUnset = baselineMttrSeconds === 0
  const mttrSeconds = props.mttrMs != null ? Math.round(props.mttrMs / 1000) : null

  // Empty state when the org has no terminal runs in the window —
  // dashboard sits dormant until the operator runs at least one workflow.
  if (terminalRunsZero) {
    return (
      <section className="we-recovery-center-value" aria-labelledby="value-dashboard-empty-heading">
        <div className="section-kicker">{t('recoveryCenter.value.kicker')}</div>
        <h2 id="value-dashboard-empty-heading" className="we-recovery-center-value__title">
          {t('recoveryCenter.value.title')}
        </h2>
        <p className="we-recovery-center-value__empty">{t('recoveryCenter.value.privateBetaPending')}</p>
      </section>
    )
  }

  const handleExport = async (format: 'markdown' | 'json') => {
    if (exporting) return
    setExporting(format)
    try {
      await downloadFromApi(`/reports/value-dashboard?windowDays=${windowDays}&format=${format}`)
    } finally {
      setExporting(null)
    }
  }

  return (
    <section className="we-recovery-center-value" aria-labelledby="value-dashboard-heading">
      <header className="we-recovery-center-value__header">
        <div>
          <div className="section-kicker">{t('recoveryCenter.value.kicker')}</div>
          <h2 id="value-dashboard-heading" className="we-recovery-center-value__title">
            {t('recoveryCenter.value.title')}
          </h2>
          <p className="we-recovery-center-value__subtitle">{t('recoveryCenter.value.subtitle')}</p>
        </div>
        <div className="we-recovery-center-value__actions">
          <button
            type="button"
            className="small-command"
            disabled={exporting !== null}
            onClick={() => void handleExport('markdown')}
          >
            <FileText size={14} aria-hidden="true" />
            {t('recoveryCenter.value.export.markdown')}
          </button>
          <button
            type="button"
            className="small-command"
            disabled={exporting !== null}
            onClick={() => void handleExport('json')}
          >
            <Download size={14} aria-hidden="true" />
            {t('recoveryCenter.value.export.json')}
          </button>
        </div>
      </header>

      <div className="we-recovery-center-value__grid">
        {/* MTTR Before */}
        <div className="we-recovery-center-value__card">
          <div className="we-recovery-center-value__label">{t('recoveryCenter.value.mttrBefore.label')}</div>
          <div className="we-recovery-center-value__value">
            {baselineUnset ? t('recoveryCenter.value.mttrBefore.empty') : formatSeconds(baselineMttrSeconds)}
          </div>
        </div>

        {/* MTTR After */}
        <div className="we-recovery-center-value__card">
          <div className="we-recovery-center-value__label">{t('recoveryCenter.value.mttrAfter.label')}</div>
          <div className="we-recovery-center-value__value">{props.mttrDisplay}</div>
        </div>

        {/* MTTR Delta */}
        {valueEstimate?.mttrDeltaSeconds != null && mttrSeconds != null && (
          <div className="we-recovery-center-value__card">
            <div className="we-recovery-center-value__label">
              {t('recoveryCenter.value.mttrDelta.label')}
              <span className="we-recovery-center-value__badge" title={t('recoveryCenter.value.estimateTooltip')}>
                <Award size={10} aria-hidden="true" />
                {t('recoveryCenter.value.estimateBadge')}
              </span>
            </div>
            <div className="we-recovery-center-value__value">
              {valueEstimate.mttrDeltaSeconds >= 0 ? '−' : '+'}
              {formatSeconds(Math.abs(valueEstimate.mttrDeltaSeconds))}
            </div>
          </div>
        )}

        {/* Clusters resolved */}
        <div className="we-recovery-center-value__card">
          <div className="we-recovery-center-value__label">
            {t('recoveryCenter.value.clustersResolved.label')}
          </div>
          <div className="we-recovery-center-value__value">
            {clustersResolved?.display ?? '0'}
          </div>
        </div>

        {/* Downtime ended (measured — no estimate badge) */}
        <div className="we-recovery-center-value__card" data-testid="value-downtime-ended">
          <div className="we-recovery-center-value__label">
            {t('recoveryCenter.value.downtimeEnded.label')}
          </div>
          <div className="we-recovery-center-value__value">
            {formatDurationHm(props.downtimeEndedMs ?? 0)}
          </div>
        </div>

        {/* Hours saved (estimate) */}
        <div className="we-recovery-center-value__card">
          <div className="we-recovery-center-value__label">
            {t('recoveryCenter.value.hoursSaved.label')}
            <span className="we-recovery-center-value__badge" title={t('recoveryCenter.value.estimateTooltip')}>
              <Award size={10} aria-hidden="true" />
              {t('recoveryCenter.value.estimateBadge')}
            </span>
          </div>
          <div className="we-recovery-center-value__value">
            {formatHours(valueEstimate?.hoursSaved ?? 0)}h
          </div>
        </div>

        {/* Dollar savings (estimate) */}
        <div className="we-recovery-center-value__card">
          <div className="we-recovery-center-value__label">
            {t('recoveryCenter.value.dollarSaved.label')}
            <span className="we-recovery-center-value__badge" title={t('recoveryCenter.value.estimateTooltip')}>
              <Award size={10} aria-hidden="true" />
              {t('recoveryCenter.value.estimateBadge')}
            </span>
          </div>
          <div className="we-recovery-center-value__value">
            {formatCurrency(valueEstimate?.dollarSaved ?? 0)}
          </div>
        </div>
      </div>
    </section>
  )
}
