/**
 * Badge that surfaces the deterministic production-readiness check from
 * the API (`POST /workflows/readiness`). Three visual states:
 *
 *   - green dot + "Production Ready" — `status: "pass"`, no findings.
 *   - amber dot + "{N} warning(s)" — `status: "warn"`, only informational
 *     issues (missing outputs, missing eval coverage placeholder, etc.).
 *   - red dot + "{N} blocker(s)" — `status: "fail"`, at least one
 *     fail-level issue (no retry on external call, hardcoded secret).
 *
 * Click expands an inline list of issues with their `code` + suggestion
 * text. The list collapses on a second click and is independent from the
 * tabbed panel — operators see it without leaving the canvas.
 *
 * Refetches on the platform-version tick (the cross-panel reactivity hook
 * the store bumps on save / run / DLQ replay), so an operator who fixes a
 * blocker and saves sees the badge flip without manual refresh.
 *
 * Used in `App.tsx`'s header next to the workflow name. Self-contained —
 * no `react-flow` / `zustand` imports beyond `useWorkflowStore` for the
 * platform-version subscription.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, AlertTriangle, ShieldAlert } from 'lucide-react'
import { api } from '../api'
import { useShallow } from 'zustand/react/shallow'
import { useWorkflowStore } from '../store'
import { tReadinessIssue, useT } from '../i18n'
import type { ReadinessIssue as ServerReadinessIssue } from '../i18n/server-events'
import { requestResilienceFocus } from './resilience-focus-bus'

type ReadinessSeverity = 'warn' | 'fail'

type ReadinessIssue = {
  code: string
  severity: ReadinessSeverity
  message: string
  nodeId?: string
  suggestion?: string
}

type ReadinessResult = {
  status: 'pass' | 'warn' | 'fail'
  issues: ReadinessIssue[]
}

const resilienceIssueCodes = new Set(['external_node_missing_retry', 'http_missing_bounds'])
const resilienceNodeTypes = new Set(['http', 'tool', 'agent', 'mcp_tool'])

export function WorkflowReadinessBadge() {
  const { t } = useT()
  // Select the canvas-to-JSON helper directly off the store rather than
  // accepting it as a prop. App.tsx's destructuring of the whole store
  // produces a fresh local binding on every re-render (which happens on
  // every node drag, every polling tick), and a prop-based dependency
  // would refetch readiness on every one of those. The selector path
  // returns the stable function reference, so the effect below only
  // refires when `platformVersion` ticks.
  const getWorkflowJson = useWorkflowStore((state) => state.getWorkflowJson)
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  // Same anti-re-render discipline as above: a raw `state.nodes` subscription
  // would re-render this always-mounted header badge on EVERY canvas drag
  // frame (each position change is a new array). Project down to the ids of
  // resilience-capable nodes with a shallow-equal selector — position changes
  // keep ids/types stable, so the badge only re-renders when membership moves.
  const resilienceNodeIds = useWorkflowStore(useShallow((state) =>
    state.nodes
      .filter((node) => resilienceNodeTypes.has(node.data.type))
      .map((node) => node.id)))
  const selectNode = useWorkflowStore((state) => state.selectNode)
  const setActiveTab = useWorkflowStore((state) => state.setActiveTab)
  const [result, setResult] = useState<ReadinessResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const workflow = getWorkflowJson()
    api('/workflows/readiness', { method: 'POST', body: JSON.stringify({ workflow }) })
      .then((payload) => {
        if (cancelled) return
        setResult(payload as ReadinessResult)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('badges.readiness.unavailable'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [getWorkflowJson, platformVersion, t])

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

  const canOpenResilienceControls = (issue: ReadinessIssue) => Boolean(
    issue.nodeId
    && resilienceIssueCodes.has(issue.code)
    && resilienceNodeIds.includes(issue.nodeId),
  )

  const openResilienceControls = (issue: ReadinessIssue) => {
    if (!issue.nodeId || !canOpenResilienceControls(issue)) return
    requestResilienceFocus(issue.nodeId)
    selectNode(issue.nodeId)
    setActiveTab('inspector')
    setExpanded(false)
  }

  return (
    <div className={`we-readiness-badge we-readiness-badge--${status}`}>
      <button
        type="button"
        className="we-readiness-badge__summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('badges.readiness.aria', { summary: summaryLabel })}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{summaryLabel}</span>
      </button>
      {expanded && issues.length > 0 && (
        <ul className="we-readiness-badge__issues">
          {issues.map((issue, index) => {
            // Translate via the server-event helper — falls back to the raw
            // engine `message` when the catalog hasn't mirrored the code yet.
            const localised = tReadinessIssue(issue as ServerReadinessIssue)
            return (
              <li key={`${issue.code}-${index}`} className={`we-readiness-issue we-readiness-issue--${issue.severity}`}>
                <strong className="we-readiness-issue__code">{issue.code}</strong>
                {issue.nodeId && <span className="we-readiness-issue__node"> · {issue.nodeId}</span>}
                <p className="we-readiness-issue__message">{localised}</p>
                {issue.suggestion && <p className="we-readiness-issue__suggestion">{issue.suggestion}</p>}
                {canOpenResilienceControls(issue) && (
                  <button
                    type="button"
                    className="we-readiness-issue__action"
                    onClick={() => openResilienceControls(issue)}
                  >
                    {t('badges.readiness.openResilience')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
