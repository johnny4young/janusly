/**
 * Usage summary card with optional multi-axis breakdown. Mounted inside
 * `RunsPanel`. The flat `Record<metric, quantity>` summary stays at
 * the top for back-compat; a chip strip below lets the operator toggle
 * one or more dimensions (provider / model / mode / day / node /
 * workflow) and renders a top-N bucket table sorted by costUsd desc
 * beneath the chips. State is local — the breakdown only fetches when
 * at least one chip is active.
 *
 * Used by:
 * - `RunsPanel.tsx` (mounted inside the Runs tab).
 * - `UsageSummaryCard.test.tsx` (pins the contract independently).
 */

import { useEffect, useMemo, useState } from 'react'
import { Gauge } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

/**
 * Closed enum mirroring `USAGE_BREAKDOWN_DIMENSIONS` in
 * `packages/engine/src/billing.ts`. Hard-coded here so we don't pull
 * the engine into the web bundle. If the backend list grows, bump
 * this list at the same time and the route validator catches drift.
 */
const USAGE_BREAKDOWN_DIMENSIONS = ['provider', 'model', 'mode', 'day', 'node', 'workflow'] as const
type UsageBreakdownDimension = typeof USAGE_BREAKDOWN_DIMENSIONS[number]

const USAGE_BREAKDOWN_LABEL_KEYS: Record<UsageBreakdownDimension, string> = {
  provider: 'rightPanel.usage.dim.provider',
  model: 'rightPanel.usage.dim.model',
  mode: 'rightPanel.usage.dim.mode',
  day: 'rightPanel.usage.dim.day',
  node: 'rightPanel.usage.dim.node',
  workflow: 'rightPanel.usage.dim.workflow',
}

type UsageBreakdownBucket = {
  key: string
  provider?: string
  model?: string
  mode?: 'ai' | 'fallback'
  day?: string
  node?: string
  workflow?: string
  quantity: number
  callCount: number
  fallbackCount: number
  costUsd: number | null
  latency: { p50Ms: number | null; p95Ms: number | null; avgMs: number | null }
}

const TOP_BUCKETS = 10

/**
 * Sentinel value the one-off backfill script (`scripts/backfill-usage-
 * workflowid.ts`) writes into `metadata.workflowId` for rows that pre-
 * date the workflow-attribution plumbing AND can't be resolved via the
 * `runs → workflow_versions` join. Rendered as "Legacy" so operators
 * can distinguish "data kept for cost continuity" from genuinely-
 * unattributed `/ai/generate-workflow` rows (which keep `workflowId:
 * null` and bucket under "unknown").
 */
const LEGACY_WORKFLOW_SENTINEL = '_legacy_pre_attribution'

/** Format a numeric quantity with k/M suffix (e.g. 8000 → "8.0k"). */
function formatQuantity(value: number): string {
  if (value < 1000) return value.toString()
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Format a USD cost ("$X.XX") or em-dash for null (unknown-model pricing). */
function formatCost(value: number | null): string {
  if (value === null) return '—'
  return `$${value.toFixed(2)}`
}

/** Format a latency value in ms ("1.2s" / "320ms" / "—"). */
function formatLatency(value: number | null): string {
  if (value === null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value)}ms`
}

/** Concatenate the per-dimension values into a human-readable label. */
function bucketLabel(b: UsageBreakdownBucket, dims: UsageBreakdownDimension[]): string {
  return dims
    .map((dim) => {
      const value = dim === 'mode' ? b.mode : b[dim]
      if (value === undefined || value === null) return runtimeT('rightPanel.usage.unknown') as string
      // Legacy-data sentinel from the backfill script — render as
      // "Legacy" so operators can distinguish backfilled-pre-attribution
      // rows from genuinely-unattributed `/ai/generate-workflow` rows
      // (which keep value === undefined → "unknown").
      if (dim === 'workflow' && value === LEGACY_WORKFLOW_SENTINEL) return runtimeT('rightPanel.usage.legacy') as string
      return value
    })
    .join(' / ')
}

/**
 * Sort comparator: rows with non-null `costUsd` first (desc), then rows
 * with null cost in the order they came in (which already reflects
 * insertion order from the in-process aggregator).
 */
function sortByCostDesc(a: UsageBreakdownBucket, b: UsageBreakdownBucket): number {
  if (a.costUsd === null && b.costUsd === null) return 0
  if (a.costUsd === null) return 1
  if (b.costUsd === null) return -1
  return b.costUsd - a.costUsd
}

export function UsageSummaryCard({
  usage,
  onRefreshPlatform,
}: {
  usage: Record<string, number>
  onRefreshPlatform: () => void
}) {
  const { t } = useT()
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [activeDims, setActiveDims] = useState<UsageBreakdownDimension[]>([])
  const [breakdown, setBreakdown] = useState<UsageBreakdownBucket[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const toggleDim = (dim: UsageBreakdownDimension) => {
    setActiveDims((prev) => {
      if (prev.includes(dim)) return prev.filter((d) => d !== dim)
      return [...prev, dim]
    })
    setShowAll(false)
  }

  const refreshUsage = () => {
    setRefreshNonce((value) => value + 1)
    void onRefreshPlatform()
  }

  // Fetch the breakdown whenever the dimension selection or
  // platformVersion changes. The local refresh nonce keeps the visible
  // breakdown in lockstep with the card's Refresh button, since the
  // parent refresh updates the flat summary without necessarily bumping
  // platformVersion.
  useEffect(() => {
    if (activeDims.length === 0) {
      setBreakdown(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const query = activeDims.join(',')
    void api(`/billing/usage?breakdown=${encodeURIComponent(query)}`)
      .then((data) => {
        if (cancelled) return
        const buckets = (data as { breakdown?: UsageBreakdownBucket[] }).breakdown
        setBreakdown(Array.isArray(buckets) ? buckets : [])
      })
      .catch((error) => {
        if (cancelled) return
        addToast(error instanceof Error ? error.message : (t('rightPanel.usage.breakdownLoadFailed') as string), 'error')
        setBreakdown([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDims, platformVersion, refreshNonce, addToast, t])

  const sortedBreakdown = useMemo(() => {
    if (!breakdown) return null
    return [...breakdown].sort(sortByCostDesc)
  }, [breakdown])

  const visibleBuckets = useMemo(() => {
    if (!sortedBreakdown) return []
    return showAll ? sortedBreakdown : sortedBreakdown.slice(0, TOP_BUCKETS)
  }, [sortedBreakdown, showAll])

  const hiddenCount = sortedBreakdown ? Math.max(0, sortedBreakdown.length - TOP_BUCKETS) : 0

  return (
    <section className="panel-card">
      <div className="split-row">
        <strong>{t('rightPanel.usage.title')}</strong>
        <button className="small-command" onClick={refreshUsage}>{t('rightPanel.usage.refresh')}</button>
      </div>
      {Object.keys(usage).length === 0 ? (
        <EmptyState
          icon={<Gauge />}
          kicker={t('rightPanel.usage.emptyKicker') as string}
          body={t('rightPanel.usage.empty') as string}
          testId="usage-empty"
        />
      ) : (
        <div className="mini-grid">
          {Object.entries(usage).map(([key, value]) => (
            <span key={key}><strong>{value}</strong>{key}</span>
          ))}
        </div>
      )}

      <div className="we-usage-breakdown-controls">
        <span className="section-kicker">{t('rightPanel.usage.groupBy')}</span>
        <div className="we-usage-breakdown-chips" role="group" aria-label={t('rightPanel.usage.dimensionsAria') as string}>
          {USAGE_BREAKDOWN_DIMENSIONS.map((dim) => {
            const active = activeDims.includes(dim)
            return (
              <button
                key={dim}
                type="button"
                className={`we-usage-breakdown-chip${active ? ' we-usage-breakdown-chip--active' : ''}`}
                onClick={() => toggleDim(dim)}
                aria-pressed={active}
              >
                {t(USAGE_BREAKDOWN_LABEL_KEYS[dim])}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <p className="helper-text" aria-live="polite">{t('rightPanel.usage.loading')}</p>}

      {!loading && sortedBreakdown && sortedBreakdown.length === 0 && (
        <p className="helper-text" aria-live="polite">{t('rightPanel.usage.noBuckets')}</p>
      )}

      {!loading && visibleBuckets.length > 0 && (
        <ul className="we-usage-breakdown-list" aria-label={t('rightPanel.usage.bucketsAria') as string}>
          {visibleBuckets.map((b) => (
            <li key={b.key} className="we-usage-breakdown-row">
              <span className="we-usage-breakdown-label">{bucketLabel(b, activeDims)}</span>
              <span className="we-usage-breakdown-stats">
                <span><strong>{b.callCount}</strong> {t('rightPanel.usage.calls')}</span>
                <span><strong>{formatQuantity(b.quantity)}</strong> {t('rightPanel.usage.tokens')}</span>
                <span><strong>{formatCost(b.costUsd)}</strong></span>
                <span>{t('rightPanel.usage.p95Prefix')} {formatLatency(b.latency.p95Ms)}</span>
                {b.fallbackCount > 0 && <span className="we-usage-breakdown-fallback">{t('rightPanel.usage.fallbackSuffix', { count: b.fallbackCount })}</span>}
              </span>
            </li>
          ))}
          {hiddenCount > 0 && !showAll && (
            <li className="we-usage-breakdown-more">
              <button type="button" className="small-command" onClick={() => setShowAll(true)}>
                {t('rightPanel.usage.moreCount', { count: hiddenCount })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
