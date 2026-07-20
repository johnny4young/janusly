/**
 * Badge that surfaces the workflow health rollup from
 * `GET /workflows/health?workflowId=…`. Three visual states:
 *
 *   - green dot + "Health: 87 / 100" — `status: "healthy"` (≥80).
 *   - amber dot + same label — `status: "warn"` (60–79).
 *   - red dot + same label — `status: "unhealthy"` (<60).
 *
 * Click expands an inline list of the six per-category sub-scores and
 * their rationale text so the operator sees what's driving the rollup.
 *
 * Refetches on the platform-version tick (the cross-panel reactivity
 * hook the store bumps on save / run / DLQ replay), so an operator who
 * fixes a readiness blocker and saves sees the badge flip without
 * reloading.
 *
 * Skipped (renders null) when `workflowId` is undefined — ad-hoc
 * unsaved workflows have no health to compute.
 *
 * Used in:
 *   - `App.tsx` workspace header next to `WorkflowReadinessBadge`
 *     (the live workflow's badge — same surface, same visual language).
 *   - `WorkflowsDashboard.tsx` row footer (per-workflow badge in the
 *     saved-workflows list, compact mode without the label).
 */

import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { tHealthRationale, useT } from '../i18n'

type HealthCategory =
  | 'reliability'
  | 'safety'
  | 'cost'
  | 'latency'
  | 'maintainability'
  | 'aiRisk'

type HealthBreakdownEntry = {
  score: number
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

type SloMetric =
  | 'successRatePercent'
  | 'mttrSeconds'
  | 'p95DurationMs'
  | 'budgetBlocksPerWindow'
  | 'stuckWaitingNodesMax'

type WorkflowSloBlock = {
  slo: {
    successRatePercent: number | null
    mttrSeconds: number | null
    p95DurationMs: number | null
    budgetBlocksPerWindow: number | null
    stuckWaitingNodesMax: number | null
    windowDays: 7 | 14 | 30
  }
  breaches: Record<SloMetric, boolean> & { anyBreach: boolean }
}

type HealthScore = {
  score: number
  status: 'healthy' | 'warn' | 'unhealthy'
  breakdown: Record<HealthCategory, HealthBreakdownEntry>
  slo?: WorkflowSloBlock | null
}

const SLO_METRIC_LABEL_KEYS: Record<SloMetric, string> = {
  successRatePercent: 'badges.slo.metric.successRatePercent',
  mttrSeconds: 'badges.slo.metric.mttrSeconds',
  p95DurationMs: 'badges.slo.metric.p95DurationMs',
  budgetBlocksPerWindow: 'badges.slo.metric.budgetBlocksPerWindow',
  stuckWaitingNodesMax: 'badges.slo.metric.stuckWaitingNodesMax',
}

const CATEGORY_LABEL_KEYS: Record<HealthCategory, string> = {
  reliability: 'badges.health.category.reliability',
  safety: 'badges.health.category.safety',
  cost: 'badges.health.category.cost',
  latency: 'badges.health.category.latency',
  maintainability: 'badges.health.category.maintainability',
  aiRisk: 'badges.health.category.aiRisk',
}

const STATUS_LABEL_KEYS: Record<HealthScore['status'], string> = {
  healthy: 'badges.health.statusHealthy',
  warn: 'badges.health.statusWarn',
  unhealthy: 'badges.health.statusUnhealthy',
}

type WorkflowHealthBadgeProps = {
  /** Saved-workflow id. Component renders null when undefined. */
  workflowId: string | undefined
  /** When true, render label as `Health: N / 100`. When false, render only the dot + score. */
  showLabel?: boolean
}

export function WorkflowHealthBadge({ workflowId, showLabel = true }: WorkflowHealthBadgeProps) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [result, setResult] = useState<HealthScore | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!workflowId) {
      setResult(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api(`/workflows/health?workflowId=${encodeURIComponent(workflowId)}`)
      .then((payload) => {
        if (cancelled) return
        setResult(payload as HealthScore)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('badges.health.unavailable'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [workflowId, platformVersion, t])

  if (!workflowId) return null
  if (error) {
    return <span className="we-readiness-badge we-readiness-badge--error">{t('badges.health.unavailable')}</span>
  }
  if (loading || !result) {
    return (
      <span className="we-readiness-badge we-readiness-badge--loading" aria-live="polite">
        <span className="we-readiness-dot we-readiness-dot--idle" /> {t('badges.health.scoring')}
      </span>
    )
  }

  // Map health status to the readiness severity tokens so the visual
  // language stays in lockstep with the readiness badge.
  const statusToSeverity: Record<HealthScore['status'], 'pass' | 'warn' | 'fail'> = {
    healthy: 'pass',
    warn: 'warn',
    unhealthy: 'fail',
  }
  const severity = statusToSeverity[result.status]
  const summaryLabel = showLabel ? t('badges.health.label', { score: result.score }) : `${result.score}`
  const localisedStatus = t(STATUS_LABEL_KEYS[result.status] as never)

  const sloBreaching = result.slo?.breaches.anyBreach === true
  const sloLabel = t('badges.slo.breachPill')

  return (
    <div className={`we-readiness-badge we-readiness-badge--${severity}`}>
      <button
        type="button"
        className="we-readiness-badge__summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('badges.health.aria', { score: result.score, status: localisedStatus })}
      >
        <Activity size={14} aria-hidden="true" />
        <span>{summaryLabel}</span>
      </button>
      {sloBreaching && (
        <span
          className="we-readiness-badge__slo-pill"
          aria-label={t('badges.slo.breachAria')}
          title={sloLabel}
        >
          {sloLabel}
        </span>
      )}
      {expanded && (
        <ul className="we-readiness-badge__issues">
          {(Object.keys(result.breakdown) as HealthCategory[]).map((category) => {
            const entry = result.breakdown[category]
            // Same severity bands as the rollup but per category — green
            // (pass) for ≥80, amber (warn) for ≥60, red (fail) below.
            const cellSeverity: 'pass' | 'warn' | 'fail' = entry.score >= 80 ? 'pass' : entry.score >= 60 ? 'warn' : 'fail'
            const categoryLabel = t(CATEGORY_LABEL_KEYS[category] as never)
            return (
              <li key={category} className={`we-readiness-issue we-readiness-issue--${cellSeverity}`}>
                <strong className="we-readiness-issue__code">{t('badges.health.cellLabel', { category: categoryLabel, score: entry.score })}</strong>
                <p className="we-readiness-issue__message">{tHealthRationale(entry)}</p>
              </li>
            )
          })}
          {result.slo ? (() => {
            const sloBlock = result.slo
            return (
              <li className={`we-readiness-issue we-readiness-issue--${sloBreaching ? 'fail' : 'pass'}`}>
                <strong className="we-readiness-issue__code">
                  {t('badges.slo.sectionTitle', { windowDays: sloBlock.slo.windowDays })}
                </strong>
                <ul className="we-readiness-badge__slo-list">
                  {(Object.keys(SLO_METRIC_LABEL_KEYS) as SloMetric[]).map((metric) => {
                    const target = sloBlock.slo[metric]
                    if (target === null) return null
                    const breaching = sloBlock.breaches[metric]
                    const metricLabel = t(SLO_METRIC_LABEL_KEYS[metric] as never)
                    return (
                      <li
                        key={metric}
                        className={`we-readiness-badge__slo-row we-readiness-badge__slo-row--${breaching ? 'breach' : 'pass'}`}
                      >
                        <span>{metricLabel}</span>
                        <span>
                          {breaching
                            ? (t('badges.slo.metricBreach', { target }))
                            : (t('badges.slo.metricPass', { target }))}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })() : null}
        </ul>
      )}
    </div>
  )
}
