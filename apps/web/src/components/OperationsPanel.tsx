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

type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
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
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        setError(err instanceof Error ? err.message : 'Recovery metrics unavailable')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion])

  return (
    <div className="panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">Workspace</div>
          <h2>Operations</h2>
          <p>Org-wide recovery posture rolled up across the last {metrics?.windowDays ?? 30} days.</p>
        </div>
        <span className="panel-heading-icon"><Gauge size={18} aria-hidden="true" /></span>
      </div>

      {error && (
        <section className="panel-card">
          <p className="helper-text">Recovery metrics unavailable — {error}</p>
        </section>
      )}

      {!error && (loading || !metrics) && (
        <section className="panel-card">
          <p className="helper-text" aria-live="polite">Computing recovery metrics…</p>
        </section>
      )}

      {!error && metrics && (
        <>
          <div className="we-ops-grid">
            <MetricCard
              icon={<CheckCircle2 size={14} aria-hidden="true" />}
              label="Workflow success rate"
              metric={metrics.successRate}
              progressValue={metrics.successRate.value}
            />
            <MetricCard
              icon={<RefreshCw size={14} aria-hidden="true" />}
              label="Mean time to recovery"
              metric={metrics.mttr}
            />
            <MetricCard
              icon={<Zap size={14} aria-hidden="true" />}
              label="p95 latency"
              metric={metrics.p95Latency}
            />
            <MetricCard
              icon={<Users size={14} aria-hidden="true" />}
              label="Approvals pending"
              metric={metrics.approvalsPending}
            />
            <MetricCard
              icon={<Clock size={14} aria-hidden="true" />}
              label="Replay success rate"
              metric={metrics.replayRate}
            />
            <MetricCard
              icon={<DollarSign size={14} aria-hidden="true" />}
              label="Cost this window"
              metric={metrics.costThisWindow}
            />
          </div>

          {metrics.costThisWindow.providers.length > 0 && (
            <section className="panel-card">
              <div className="section-kicker">Cost breakdown</div>
              <table className="we-ops-cost-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>USD</th>
                    <th>Tokens</th>
                    <th>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.costThisWindow.providers.map((row) => (
                    <tr key={`${row.provider}::${row.model}`}>
                      <td>{row.provider}</td>
                      <td><code>{row.model}</code></td>
                      <td>${row.usd.toFixed(4)}</td>
                      <td>{row.tokens.toLocaleString()}</td>
                      <td>{row.calls.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <FailureClustersCard />
        </>
      )}
    </div>
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
      <p className="helper-text we-ops-metric-card__rationale">{metric.rationale}</p>
    </section>
  )
}
