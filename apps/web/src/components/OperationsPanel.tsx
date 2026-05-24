/**
 * Org-level Operations dashboard. Calls `GET /recovery/metrics` and
 * renders a metric grid (success rate, MTTR, p95 latency, approvals
 * pending, replay rate, cost) plus the existing failure-clusters card.
 *
 * Each metric card shows: severity-tinted left border, value display,
 * one-line rationale. `null`-valued metrics render `"—"` with an empty
 * helper line. Refetches on the cross-panel `platformVersion` tick.
 *
 * Used by `RightPanel.tsx` for the `'operations'` tab. Slated for
 * reuse in the eventual standalone Operations page.
 */

import React, { useEffect, useState } from 'react'
import { CheckCircle2, Clock, DollarSign, Gauge, RefreshCw, Users, Zap } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { FailureClustersCard } from './FailureClustersCard'
import { BudgetSettingsPanel } from './BudgetSettingsPanel'
import { AuthPolicySettingsPanel } from './AuthPolicySettingsPanel'
import { ScimDirectorySettingsPanel } from './ScimDirectorySettingsPanel'
import { PermissionGrantsPanel } from './PermissionGrantsPanel'
import { CredentialHealthCard } from './CredentialHealthCard'
import { AlertPoliciesPanel } from './AlertPoliciesPanel'
import { RecentAlertsCard } from './RecentAlertsCard'
import { McpConnectionsPanel } from './McpConnectionsPanel'
import { getResolvedLocale, tRecoveryMetricRationale, useT } from '../i18n'

/** Public ``/health`` rate-limiter payload — matches
 *  ``RateLimiterPublicHealth`` from ``@janusly/data/src/rate-limit-degradation``
 *  byte-for-byte. Truncated server-side so internal Redis error text +
 *  bucket keys never reach the public route. */
type RateLimiterHealth = {
  healthy: boolean
  degradedBuckets: Array<{
    bucket: string
    errorCount: number
    firstObservedAt: string
    lastObservedAt: string
  }>
}

type HealthPayload = {
  ok: boolean
  rateLimiter?: RateLimiterHealth
}

type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

type CostProviderRow = {
  provider: string
  model: string
  usd: number
  tokens: number
  calls: number
}

type RecoveryMetrics = {
  successRate: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[] }
  windowDays: number
  terminalRuns: number
}

export function OperationsPanel() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Rate-limiter health is fetched in parallel with metrics on the
  // existing platformVersion tick. The chip stays mounted regardless
  // of metrics state so a Redis blip during the loading window still
  // surfaces. We deliberately do NOT propagate /health failures into
  // `error` — the chip degrades silently when the call fails (a 404
  // on an older API replica would otherwise mask the metrics surface).
  const [rateLimiterHealth, setRateLimiterHealth] = useState<RateLimiterHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/recovery/metrics')
      .then((payload) => {
        if (cancelled) return
        setMetrics(payload as RecoveryMetrics)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : (t('operations.metricsUnavailable', { detail: '' }) as string))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  useEffect(() => {
    let cancelled = false
    api('/health')
      .then((payload) => {
        if (cancelled) return
        const health = (payload as HealthPayload).rateLimiter
        setRateLimiterHealth(health ?? null)
      })
      .catch(() => {
        // Silent degrade — the chip is observability, not load-bearing.
        if (cancelled) return
        setRateLimiterHealth(null)
      })
    return () => { cancelled = true }
  }, [platformVersion])

  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{t('operations.kicker')}</div>
          <h2>{t('operations.title')}</h2>
          <p>{t('operations.intro', { days: metrics?.windowDays ?? 30 })}</p>
        </div>
        <span className="panel-heading-icon"><Gauge size={18} aria-hidden="true" /></span>
      </div>

      {rateLimiterHealth && (
        <RateLimiterStatusChip health={rateLimiterHealth} />
      )}

      {error && (
        <section className="panel-card">
          <p className="helper-text">{t('operations.metricsUnavailable', { detail: error })}</p>
        </section>
      )}

      {!error && (loading || !metrics) && (
        <section className="panel-card">
          <p className="helper-text" aria-live="polite">{t('operations.computing')}</p>
        </section>
      )}

      {!error && metrics && (
        <>
          <div className="we-ops-grid">
            <MetricCard
              icon={<CheckCircle2 size={14} aria-hidden="true" />}
              label={t('operations.metric.successRate') as string}
              metric={metrics.successRate}
              progressValue={metrics.successRate.value}
            />
            <MetricCard
              icon={<RefreshCw size={14} aria-hidden="true" />}
              label={t('operations.metric.mttr') as string}
              metric={metrics.mttr}
            />
            <MetricCard
              icon={<Zap size={14} aria-hidden="true" />}
              label={t('operations.metric.p95') as string}
              metric={metrics.p95Latency}
            />
            <MetricCard
              icon={<Users size={14} aria-hidden="true" />}
              label={t('operations.metric.approvals') as string}
              metric={metrics.approvalsPending}
            />
            <MetricCard
              icon={<Clock size={14} aria-hidden="true" />}
              label={t('operations.metric.replayRate') as string}
              metric={metrics.replayRate}
            />
            <MetricCard
              icon={<DollarSign size={14} aria-hidden="true" />}
              label={t('operations.metric.cost') as string}
              metric={metrics.costThisWindow}
            />
          </div>

          {metrics.costThisWindow.providers.length > 0 && (
            <section className="panel-card">
              <div className="section-kicker">{t('operations.cost.heading')}</div>
              <table className="we-ops-cost-table">
                <thead>
                  <tr>
                    <th>{t('operations.cost.col.provider')}</th>
                    <th>{t('operations.cost.col.model')}</th>
                    <th>{t('operations.cost.col.usd')}</th>
                    <th>{t('operations.cost.col.tokens')}</th>
                    <th>{t('operations.cost.col.calls')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.costThisWindow.providers.map((row) => (
                    <tr key={`${row.provider}::${row.model}`}>
                      <td>{row.provider}</td>
                      <td><code>{row.model}</code></td>
                      <td>${row.usd.toFixed(4)}</td>
                      <td>{row.tokens.toLocaleString(getResolvedLocale())}</td>
                      <td>{row.calls.toLocaleString(getResolvedLocale())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <FailureClustersCard />

          <BudgetSettingsPanel />

          <AuthPolicySettingsPanel />

          <ScimDirectorySettingsPanel />

          <PermissionGrantsPanel />

          <CredentialHealthCard />

          <AlertPoliciesPanel />

          <RecentAlertsCard />

          <McpConnectionsPanel />
        </>
      )}
    </div>
  )
}

/**
 * Status chip surfacing Redis-backed rate-limiter degradation. Mounted
 * inside ``OperationsPanel``; two states:
 *
 * - **Healthy** (default): subtle green chip, copy: "Rate limiter healthy".
 * - **Degraded**: amber chip, copy: "Rate limiter degraded — N bucket(s)
 *   failing open. Traffic still allowed." Tooltip lists the affected
 *   bucket names.
 *
 * The "Traffic still allowed" framing intentionally distinguishes this
 * non-blocking signal from ``BudgetBlockedBanner`` ("AI workflow budget
 * exceeded — blocked"). Operators reading both surfaces should never
 * confuse a Redis blip with a hard budget block.
 */
function RateLimiterStatusChip({ health }: { health: RateLimiterHealth }) {
  const { t } = useT()
  if (health.healthy) {
    return (
      <span
        className="we-ops-rate-limiter-chip we-ops-rate-limiter-chip--healthy"
        role="status"
        aria-label={t('operations.rateLimiter.label') as string}
      >
        <span className="we-ops-rate-limiter-chip__dot" aria-hidden="true" />
        <span>{t('operations.rateLimiter.healthy')}</span>
      </span>
    )
  }
  const bucketCount = health.degradedBuckets.length
  const bucketNames = health.degradedBuckets.map((b) => b.bucket).join(', ')
  const tooltip = t('operations.rateLimiter.degradedBucketsTooltip', { buckets: bucketNames }) as string
  return (
    <span
      className="we-ops-rate-limiter-chip we-ops-rate-limiter-chip--degraded"
      role="status"
      aria-label={t('operations.rateLimiter.label') as string}
      title={tooltip}
    >
      <span className="we-ops-rate-limiter-chip__dot" aria-hidden="true" />
      <span>{t('operations.rateLimiter.degraded', { count: bucketCount })}</span>
    </span>
  )
}

function MetricCard({
  icon,
  label,
  metric,
  progressValue,
}: {
  icon: React.ReactNode
  label: string
  metric: RecoveryMetric
  /** When set (0–100), renders a thin progress bar tinted by the metric's severity. */
  progressValue?: number | null
}) {
  return (
    <section className={`panel-card we-ops-metric-card we-ops-metric-card--${metric.severity}`}>
      <div className="we-ops-metric-card__head">
        <span className="we-ops-metric-card__icon" aria-hidden="true">{icon}</span>
        <span className="section-kicker we-ops-metric-card__label">{label}</span>
      </div>
      <div className="we-ops-metric-card__value">{metric.display}</div>
      {typeof progressValue === 'number' && progressValue !== null && (
        <div className="we-ops-progress" role="presentation">
          <span className="we-ops-progress__rail" />
          <span
            className={`we-ops-progress__fill we-ops-progress__fill--${metric.severity}`}
            style={{ width: `${Math.max(0, Math.min(100, progressValue))}%` }}
          />
        </div>
      )}
      <p className="helper-text we-ops-metric-card__rationale">{tRecoveryMetricRationale(metric)}</p>
    </section>
  )
}
