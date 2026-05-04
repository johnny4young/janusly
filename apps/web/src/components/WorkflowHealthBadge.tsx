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
}

type HealthScore = {
  score: number
  status: 'healthy' | 'warn' | 'unhealthy'
  breakdown: Record<HealthCategory, HealthBreakdownEntry>
}

const CATEGORY_LABELS: Record<HealthCategory, string> = {
  reliability: 'Reliability',
  safety: 'Safety',
  cost: 'Cost',
  latency: 'Latency',
  maintainability: 'Maintainability',
  aiRisk: 'AI risk',
}

type WorkflowHealthBadgeProps = {
  /** Saved-workflow id. Component renders null when undefined. */
  workflowId: string | undefined
  /** When true, render label as `Health: N / 100`. When false, render only the dot + score. */
  showLabel?: boolean
}

export function WorkflowHealthBadge({ workflowId, showLabel = true }: WorkflowHealthBadgeProps) {
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
        setError(err instanceof Error ? err.message : 'Health unavailable')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [workflowId, platformVersion])

  if (!workflowId) return null
  if (error) {
    return <span className="we-readiness-badge we-readiness-badge--error">Health unavailable</span>
  }
  if (loading || !result) {
    return (
      <span className="we-readiness-badge we-readiness-badge--loading" aria-live="polite">
        <span className="we-readiness-dot we-readiness-dot--idle" /> Scoring…
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
  const summaryLabel = showLabel ? `Health: ${result.score} / 100` : `${result.score}`

  return (
    <div className={`we-readiness-badge we-readiness-badge--${severity}`}>
      <button
        type="button"
        className="we-readiness-badge__summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`Workflow health: ${result.score} of 100 (${result.status})`}
      >
        <Activity size={14} aria-hidden="true" />
        <span>{summaryLabel}</span>
      </button>
      {expanded && (
        <ul className="we-readiness-badge__issues">
          {(Object.keys(result.breakdown) as HealthCategory[]).map((category) => {
            const entry = result.breakdown[category]
            // Same severity bands as the rollup but per category — green
            // (pass) for ≥80, amber (warn) for ≥60, red (fail) below.
            const cellSeverity: 'pass' | 'warn' | 'fail' = entry.score >= 80 ? 'pass' : entry.score >= 60 ? 'warn' : 'fail'
            return (
              <li key={category} className={`we-readiness-issue we-readiness-issue--${cellSeverity}`}>
                <strong className="we-readiness-issue__code">{CATEGORY_LABELS[category]}: {entry.score}</strong>
                <p className="we-readiness-issue__message">{entry.rationale}</p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
