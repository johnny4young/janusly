/**
 * Recovery Center tile family.
 *
 * All tiles share the `RecoveryCenterTile` shell (header + body + optional
 * footer link) and the `AllClearState` empty-state. These are secondary
 * insight tiles only; operational queue, approval, and semantic-case rows
 * belong to Activity or their exact workspaces. Most tiles take data from
 * Home, while `BudgetTile` and `CalibrationHealthTile` own distinct
 * read-only endpoints that the Home snapshot does not fetch.
 *
 * Pure presentational logic lives in `recovery-center-model.ts`.
 *
 * Used by `HomeInsights.tsx`.
 */

import React, { useEffect, useState } from 'react'
import {
  BarChart3,
  ChevronRight,
  CircleCheck,
  Coins,
  Eye,
  Gauge,
} from 'lucide-react'
import type { ActiveTab } from '../../types'
import { api } from '../../api'
import { useWorkflowStore } from '../../store'
import { getResolvedLocale, useT } from '../../i18n'
import { requestOperationsSection } from '../operations-section-bus'
import { selectRecoveryTimeMetric } from '../recovery-metrics'
import { approachLabelDisplay } from '../recovery-dialog/recovery-dialog-model'
import type { PatchApproachLabel } from '../recovery-dialog/types'
import {
  budgetBand,
  type CalibrationStatusEnvelope,
  clusterCategoryLabel,
  clusterOwnerLabel,
  type BudgetEnvelope,
  type FailureCluster,
  type RecommendedActionSeverity,
  type RecoveryMetrics,
} from './recovery-center-model'

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterTile — the shared shell every tile renders into.
// ─────────────────────────────────────────────────────────────────────────

export function RecoveryCenterTile({
  title,
  kicker,
  severity,
  icon,
  footer,
  children,
  testId,
}: {
  title: string
  kicker: string
  severity?: RecommendedActionSeverity | 'neutral'
  icon: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  testId: string
}) {
  return (
    <section
      className="we-recovery-center-tile"
      data-severity={severity ?? 'neutral'}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <header className="we-recovery-center-tile__head">
        <span className="we-recovery-center-tile__icon" aria-hidden="true">{icon}</span>
        <div className="we-recovery-center-tile__heading">
          <div className="section-kicker">{kicker}</div>
          <h2 id={`${testId}-title`}>{title}</h2>
        </div>
      </header>
      <div className="we-recovery-center-tile__body">
        {children}
      </div>
      {footer && <footer className="we-recovery-center-tile__footer">{footer}</footer>}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AllClearState — shared "everything is OK" empty-state component.
// Stylized with a soft success ring + check glyph + reassuring copy.
// Used inside each tile when there's no work for the operator.
// ─────────────────────────────────────────────────────────────────────────

function AllClearState({ message, testId }: { message: string; testId?: string }) {
  const { t } = useT()
  return (
    <div className="we-recovery-allclear" data-testid={testId}>
      <span className="we-recovery-allclear__ring" aria-hidden="true">
        <CircleCheck size={18} />
      </span>
      <div className="we-recovery-allclear__copy">
        <strong>{t('recoveryCenter.allClear.title')}</strong>
        <span>{message}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OperatorTodayTile — mini stats grid mirroring the right rail of
// `ui_kits/studio/home-operator.html` (Runs / Success / Spend / MTTR).
// ─────────────────────────────────────────────────────────────────────────

export function OperatorTodayTile({
  metrics,
  openDeadLetters,
  waitingNodes,
  onOpenTab,
}: {
  metrics: RecoveryMetrics | null
  openDeadLetters: number
  waitingNodes: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const recoveryTime = metrics ? selectRecoveryTimeMetric(metrics) : null
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.today.title')}
      kicker={t('recoveryCenter.tile.today.kicker')}
      severity="cobalt"
      icon={<BarChart3 size={18} aria-hidden="true" />}
      testId="recovery-center-tile-today"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
        >
          {t('recoveryCenter.tile.today.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      <div className="we-operator-mini">
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.runs')}</div>
          <div className="we-operator-mini__val">{metrics?.terminalRuns ?? 0}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.windowDays', { days: metrics?.windowDays ?? 30 })}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.success')}</div>
          <div className="we-operator-mini__val">{metrics?.successRate.display ?? '—'}</div>
          <div className="we-operator-mini__delta" data-severity={metrics?.successRate.severity ?? 'neutral'}>{metrics?.successRate.severity ?? '—'}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.failures')}</div>
          <div className="we-operator-mini__val">{openDeadLetters}</div>
          <div className="we-operator-mini__delta" data-severity={openDeadLetters === 0 ? 'success' : 'danger'}>{openDeadLetters === 0 ? t('recoveryCenter.tile.today.clean') : t('recoveryCenter.tile.today.pending')}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.mttr')}</div>
          <div className="we-operator-mini__val">{recoveryTime?.display ?? '—'}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.pending')} {waitingNodes}</div>
        </div>
      </div>
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// FailureClustersTile — normalized recurring failure signatures.
// ─────────────────────────────────────────────────────────────────────────

export function FailureClustersTile({
  clusters,
  totalSamples,
  onOpenTab,
}: {
  clusters: FailureCluster[]
  totalSamples: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.clusters.title')}
      kicker={t('recoveryCenter.tile.clusters.kicker', { count: totalSamples })}
      severity={clusters.length === 0 ? 'success' : 'cobalt'}
      icon={<Eye size={18} aria-hidden="true" />}
      testId="recovery-center-tile-clusters"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
          data-testid="recovery-center-clusters-open-all"
        >
          {t('recoveryCenter.tile.clusters.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {clusters.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.clusters.empty')}
          testId="recovery-center-clusters-allclear"
        />
      ) : (
        <ul className="we-recovery-watch">
          {clusters.map((cluster) => {
            const state = cluster.recurredAfterRecovery
              ? 'recurrent'
              : cluster.frequency >= 2 ? 'ready' : 'monitoring'
            const stateLabel = state === 'recurrent'
              ? t('recoveryCenter.tile.clusters.stateRecurred')
              : state === 'ready'
                ? t('recoveryCenter.tile.clusters.statePatchReady')
                : t('recoveryCenter.tile.clusters.stateMonitoring')
            return (
              <li key={cluster.signature}>
                <div className="we-recovery-watch-row" data-testid={`recovery-center-watch-row-${cluster.signature}`}>
                  <span className="we-recovery-watch-row__sig">{cluster.signature}</span>
                  <div className="we-recovery-watch-row__body">
                    <span className={`mode-pill we-cluster-pill--${cluster.category}`}>{clusterCategoryLabel(cluster.category)}</span>
                    <small>{t('recoveryCenter.tile.clusters.frequency', { count: cluster.frequency })} · {clusterOwnerLabel(cluster.suggestedOwner)}</small>
                  </div>
                  <span className={`we-recovery-watch-row__state we-recovery-watch-row__state--${state}`}>{stateLabel}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// CalibrationHealthTile — read-only proof that recovery feedback calibrates
// future patch suggestions. Owns its `/recovery/calibration-status` fetch,
// analogous to BudgetTile's distinct endpoint.
// ─────────────────────────────────────────────────────────────────────────

export function CalibrationHealthTile() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [status, setStatus] = useState<CalibrationStatusEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const locale = getResolvedLocale()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/recovery/calibration-status')
      .then((payload) => {
        if (cancelled) return
        setStatus(payload as CalibrationStatusEnvelope)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('recoveryCenter.calibration.unavailableFallback'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  const curves = status?.calibrations ?? []
  const severity = error
    ? 'warning'
    : !status
      ? 'neutral'
      : !status.enabled
        ? 'neutral'
        : curves.length > 0
          ? 'success'
          : 'cyan'
  const kicker = !status
    ? t('recoveryCenter.calibration.kickerCollecting')
    : !status.enabled
      ? t('recoveryCenter.calibration.kickerDisabled')
      : curves.length > 0
        ? t('recoveryCenter.calibration.kickerEnabled', { count: curves.length })
        : t('recoveryCenter.calibration.kickerCollecting')
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  const formatDate = (value: string | null) => {
    if (!value) return t('common.unknown')
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? t('common.unknown')
      : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.calibration.title')}
      kicker={kicker}
      severity={severity}
      icon={<Gauge size={18} aria-hidden="true" />}
      testId="recovery-center-tile-calibration"
    >
      {loading && <p className="we-recovery-center-tile__empty">{t('recoveryCenter.calibration.loading')}</p>}
      {error && (
        <p className="we-recovery-center-tile__empty" role="status">
          {t('recoveryCenter.calibration.unavailable', { detail: error })}
        </p>
      )}
      {!loading && !error && status && !status.enabled && (
        <p className="we-recovery-center-tile__empty">{t('recoveryCenter.calibration.disabledBody')}</p>
      )}
      {!loading && !error && status?.enabled && curves.length === 0 && (
        <p className="we-recovery-center-tile__empty">
          {t('recoveryCenter.calibration.empty', { minimumSamples: status.minimumSampleSize })}
        </p>
      )}
      {!loading && !error && status?.enabled && curves.length > 0 && (
        <ul className="we-recovery-center-calibration" data-testid="recovery-center-calibration-rows">
          {curves.map((curve) => (
            <li key={curve.approachLabel} data-testid={`recovery-center-calibration-row-${curve.approachLabel}`}>
              <div className="we-recovery-center-calibration__head">
                <strong>{approachLabelDisplay(curve.approachLabel as PatchApproachLabel)}</strong>
                <span>{t('recoveryCenter.calibration.acceptRate', { rate: percent.format(curve.acceptRate) })}</span>
              </div>
              <div className="we-recovery-center-calibration__meta">
                <span>{t('recoveryCenter.calibration.samples', { count: curve.sampleSize })}</span>
                <span>{t('recoveryCenter.calibration.slope', { value: decimal.format(curve.curveSlope) })}</span>
                <span>{t('recoveryCenter.calibration.updated', { date: formatDate(curve.lastComputedAt) })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// BudgetTile — MTD AI spend bar. Owns its own `/billing/budget` fetch (a
// distinct endpoint from the panel's `/recovery/metrics`).
// ─────────────────────────────────────────────────────────────────────────

export function BudgetTile({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [envelope, setEnvelope] = useState<BudgetEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/billing/budget')
      .then((payload) => {
        if (cancelled) return
        setEnvelope(payload as BudgetEnvelope)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('recoveryCenter.budget.unavailableFallback'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  const band = budgetBand(envelope)
  // `budgetBand` already returns the exact tile-severity union — no remap.
  const tileSeverity = band
  const limit = envelope?.monthlyUsdLimit ?? null
  const spent = envelope?.monthlyUsdSpent ?? 0
  const hasBudget = limit !== null && limit > 0
  const ratio = hasBudget ? Math.min(1, spent / (limit ?? 1)) : 0
  const formatMoney = (value: number) => value.toFixed(2)

  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.budget.title')}
      kicker={hasBudget ? t('recoveryCenter.budget.kickerUsed', { percent: (ratio * 100).toFixed(0) }) : t('recoveryCenter.budget.kickerNotConfigured')}
      severity={tileSeverity}
      icon={<Coins size={18} aria-hidden="true" />}
      testId="recovery-center-tile-budget"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => {
            requestOperationsSection('reliability')
            onOpenTab('operations')
          }}
          data-testid="recovery-center-budget-open-settings"
        >
          {hasBudget ? t('recoveryCenter.budget.openSettings') : t('recoveryCenter.budget.setBudget')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {loading && <p className="we-recovery-center-tile__empty">{t('recoveryCenter.budget.loading')}</p>}
      {error && (
        <p className="we-recovery-center-tile__empty" role="status">{t('recoveryCenter.budget.unavailable', { detail: error })}</p>
      )}
      {!loading && !error && !hasBudget && (
        <p className="we-recovery-center-tile__empty">
          {t('recoveryCenter.budget.notConfiguredBody')}
        </p>
      )}
      {!loading && !error && hasBudget && (
        <div className="we-recovery-center-budget" data-testid="recovery-center-budget-bar" data-band={band}>
          <div className="we-recovery-center-budget__row">
            <span className="we-recovery-center-budget__label">{t('recoveryCenter.budget.mtdLabel')}</span>
            <span className="we-recovery-center-budget__value">{t('recoveryCenter.budget.mtdValue', { spent: formatMoney(spent), limit: formatMoney(limit ?? 0) })}</span>
          </div>
          <div className="we-recovery-center-budget__bar" role="presentation" aria-hidden="true">
            <span className="we-recovery-center-budget__bar-rail" />
            <span
              className={`we-recovery-center-budget__bar-fill we-recovery-center-budget__bar-fill--${band}`}
              style={{ width: `${Math.max(2, ratio * 100)}%` }}
            />
          </div>
          <div className="we-recovery-center-budget__meta">
            <span>{t('recoveryCenter.budget.policyLabel')} <code>{envelope?.policy ?? 'warn'}</code></span>
            {envelope?.warningThresholdCrossed && (
              <span className="we-recovery-center-budget__pill" data-severity={band}>{t('recoveryCenter.budget.overWarning')}</span>
            )}
          </div>
        </div>
      )}
    </RecoveryCenterTile>
  )
}
