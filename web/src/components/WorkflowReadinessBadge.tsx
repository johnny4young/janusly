/**
 * Badge that surfaces the deterministic production-readiness check from
 * the API (`POST /workflows/readiness`). Three visual states:
 *
 *   - green dot + "Production · Ready" — `status: "pass"`, no findings.
 *   - amber dot + "Production · {N} warning(s)" — `status: "warn"`, only informational
 *     issues (missing outputs, missing eval coverage placeholder, etc.).
 *   - red dot + "Production · {N} blocker(s)" — `status: "fail"`, at least one
 *     fail-level issue (no retry on external call, hardcoded secret).
 *
 * The summary opens the canonical authoring Problems scope. That surface owns
 * deduplication, localization, and deep links; the header never exposes a
 * second technical issue list.
 *
 * Refetches on semantic workflow revisions and the platform-version tick (the
 * cross-panel reactivity hook bumped on save / run / DLQ replay). Semantic
 * edits are debounced; canvas-only position changes do not trigger a request.
 *
 * Used in `App.tsx`'s header next to the workflow name. Self-contained —
 * no `react-flow` / `zustand` imports beyond `useWorkflowStore` for the
 * platform-version subscription.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, AlertTriangle, ShieldAlert } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import type { ReadinessResult } from '../types'

export function WorkflowReadinessBadge({
  onOpenProblems,
  onResult,
}: {
  onOpenProblems: () => void
  onResult?: (result: ReadinessResult | null) => void
}) {
  const { t } = useT()
  // Select the canvas-to-JSON helper directly off the store rather than
  // accepting it as a prop. App.tsx's destructuring of the whole store
  // produces a fresh local binding on every re-render (which happens on
  // every node drag, every polling tick), and a prop-based dependency
  // would refetch readiness on every one of those. The selector path
  // returns the stable function reference, so the effect below only refires
  // for an explicit platform tick or serialized-workflow revision.
  const getWorkflowJson = useWorkflowStore((state) => state.getWorkflowJson)
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const workflowRevision = useWorkflowStore((state) => state.workflowRevision)
  const [result, setResult] = useState<ReadinessResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    onResult?.(null)
    // Semantic edits can arrive on every keystroke. Debounce the deterministic
    // API check while still clearing stale findings immediately; canvas drags
    // never increment `workflowRevision` and therefore never reach this path.
    const timer = window.setTimeout(() => {
      const workflow = getWorkflowJson()
      api('/workflows/readiness', { method: 'POST', body: JSON.stringify({ workflow }) })
        .then((payload) => {
          if (cancelled) return
          const next = payload as ReadinessResult
          setResult(next)
          onResult?.(next)
          setLoading(false)
        })
        .catch((err) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : t('badges.readiness.unavailable'))
          onResult?.(null)
          setLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [getWorkflowJson, onResult, platformVersion, t, workflowRevision])

  if (error) {
    return <span className="we-readiness-badge we-readiness-badge--error">{t('badges.readiness.unavailable')}</span>
  }
  if (loading || !result) {
    return (
      <span className="we-readiness-badge we-readiness-badge--loading" aria-live="polite">
        <span className="we-readiness-dot we-readiness-dot--idle" /> {t('badges.readiness.checking')}
      </span>
    )
  }

  const { status, issues } = result
  const failCount = issues.filter((issue) => issue.severity === 'fail').length
  const warnCount = issues.filter((issue) => issue.severity === 'warn').length

  const summaryLabel = status === 'pass'
    ? t('badges.readiness.productionReady')
    : status === 'warn'
      ? t('badges.readiness.warnings', { count: warnCount })
      : t('badges.readiness.blockers', { count: failCount })
  const Icon = status === 'pass' ? ShieldCheck : status === 'warn' ? AlertTriangle : ShieldAlert

  return (
    <div className={`we-readiness-badge we-readiness-badge--${status}`}>
      <button
        type="button"
        className="we-readiness-badge__summary"
        onClick={onOpenProblems}
        aria-label={t('badges.readiness.aria', { summary: summaryLabel })}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{summaryLabel}</span>
      </button>
    </div>
  )
}
