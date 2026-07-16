/**
 * Operations dashboard shell. Replaces the legacy vertical stack with a
 * sticky sub-tab rail + active-only content column.
 *
 * The four closed sub-tabs (Overview / Reliability / Access / Integrations)
 * mount their own cards on demand — inactive sub-tabs literally don't
 * render, so their `useEffect` fetches never fire. This drops the
 * per-refresh API call count from ~9 (every card self-fetched on mount)
 * to ~3-4 (header metrics + public/admin infra health, plus whichever cards
 * the active sub-tab carries).
 *
 * Active sub-tab is persisted to localStorage under
 * `janusly:operations:section` so the operator lands where they left
 * off. A defensive `isSection()` guard collapses unknown values back to
 * `overview` — same posture as `BuilderSidebar`'s stored-state loader.
 *
 * Wired into `RightPanel.tsx` for the `'operations'` tab — this shell owns
 * the mounted operations experience.
 */

import React, { useEffect, useState } from 'react'
import { Gauge, Plug, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { FailureClustersCard } from './FailureClustersCard'
import { BudgetSettingsPanel } from './BudgetSettingsPanel'
import { AiGuidanceSettingsPanel } from './AiGuidanceSettingsPanel'
import { AuthPolicySettingsPanel } from './AuthPolicySettingsPanel'
import { ScimDirectorySettingsPanel } from './ScimDirectorySettingsPanel'
import { AuditLogPanel } from './AuditLogPanel'
import { PermissionGrantsPanel } from './PermissionGrantsPanel'
import { MemoryGovernancePanel } from './MemoryGovernancePanel'
import { CredentialHealthCard } from './CredentialHealthCard'
import { AlertPoliciesPanel } from './AlertPoliciesPanel'
import { UpstreamHealthPanel } from './UpstreamHealthPanel'
import { RecentAlertsCard } from './RecentAlertsCard'
import { McpConnectionsPanel } from './McpConnectionsPanel'
import { VitalSignsStrip } from './VitalSignsStrip'
import { RunStreamChip } from './RunStreamChip'
import {
  parseQueueHealth,
  QueueLagChip,
  queueNeedsAttention,
  type QueueHealth,
  type QueueUnavailableReason,
} from './QueueLagChip'
import { buildOperationsTiles } from './operations-tiles'
import {
  OPERATIONS_SECTION_REQUEST_EVENT as SECTION_REQUEST_EVENT,
  isOpsSection as isSection,
  loadStoredOpsSection as loadStoredSection,
  persistOpsSection as persistSection,
  type OpsSection,
} from './operations-section-bus'
import { getResolvedLocale, useT } from '../i18n'

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
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  calls: number
  aggregated?: boolean
}

type CacheEfficiency = {
  inputTokens: number
  readTokens: number
  creationTokens: number
  readSharePercent: number | null
}

type RecoveryMetrics = {
  successRate: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  slaAttainment?: RecoveryMetric
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[]; cache: CacheEfficiency }
  windowDays: number
  terminalRuns: number
}

/**
 * Sandbox zeros read as "no signal", not red. When no run has reached a
 * terminal state yet, the signal metrics (success / mttr / p95 / replay /
 * cost) carry no real data — present them neutral regardless of the
 * server's band so an empty workspace doesn't look like a broken product.
 * `approvalsPending` is left alone (0 pending == healthy, never alarming).
 * No-op the moment any run is terminal, so a seeded/real workspace shows
 * its true bands.
 */
function neutralizeSandboxZeros(metrics: RecoveryMetrics | null): RecoveryMetrics | null {
  if (!metrics || metrics.terminalRuns > 0) return metrics
  const neutral = <T extends RecoveryMetric>(metric: T): T =>
    metric.severity === 'neutral' ? metric : { ...metric, severity: 'neutral' as MetricSeverity }
  return {
    ...metrics,
    successRate: neutral(metrics.successRate),
    mttr: neutral(metrics.mttr),
    p95Latency: neutral(metrics.p95Latency),
    replayRate: neutral(metrics.replayRate),
    costThisWindow: {
      ...neutral(metrics.costThisWindow),
      providers: metrics.costThisWindow.providers,
      cache: metrics.costThisWindow.cache,
    },
  }
}

// The section bus (sub-section enum + deep-link helper) lives in its own
// module so OperationsPage stays code-splittable — see operations-section-bus.
// Re-exported here for back-compat with existing `from './OperationsPage'`
// callers; new callers should import from the bus directly.
export { requestOperationsSection } from './operations-section-bus'
export type { OpsSection } from './operations-section-bus'

type SignalSummary = {
  /** `/health` rate-limiter snapshot. Drives the chip and Reliability dot. */
  rateLimiter: RateLimiterHealth | null
  /** Admin queue snapshot; null means unavailable, undefined means not checked yet. */
  queue: QueueHealth | null | undefined
  /** Most recent 402 envelope captured by the API wrapper. Drives Reliability dot. */
  budgetBlocked: unknown
  /** True when at least one `/recovery/metrics` value is in the "unhealthy" band.
   *  Drives Overview dot — a proxy for "operator should look at this tab". */
  overviewUnhealthy: boolean
}

type QueueSignalState = {
  health: QueueHealth | null
  unavailableReason: QueueUnavailableReason
}

function isForbiddenApiError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && (error as { statusCode?: unknown }).statusCode === 403
}

export function OperationsPage() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const budgetBlocked = useWorkflowStore((state) => state.budgetBlocked)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Rate-limiter health is independent of metrics and degrades silently on
  // /health failure — operators still see the rest of the page.
  const [rateLimiterHealth, setRateLimiterHealth] = useState<RateLimiterHealth | null>(null)
  // When the last /health snapshot landed — shown as an "as of" on the chip so a
  // stalled poll (the snapshot frozen) reads as stale rather than current.
  const [rateLimiterCheckedAt, setRateLimiterCheckedAt] = useState<number | null>(null)
  const [queueSignal, setQueueSignal] = useState<QueueSignalState | undefined>(undefined)
  const [queueCheckedAt, setQueueCheckedAt] = useState<number | null>(null)
  const [section, setSection] = useState<OpsSection>(() => loadStoredSection())

  // Persist on every section change. Tiny write — no debounce needed.
  useEffect(() => {
    persistSection(section)
  }, [section])

  useEffect(() => {
    const handleSectionRequest = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null
      if (isSection(next)) setSection(next)
    }
    window.addEventListener(SECTION_REQUEST_EVENT, handleSectionRequest)
    return () => window.removeEventListener(SECTION_REQUEST_EVENT, handleSectionRequest)
  }, [])

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
        setError(err instanceof Error ? err.message : (t('operations.metricsUnavailable', { detail: '' })))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  useEffect(() => {
    let cancelled = false
    let queueForbidden = false
    const loadHealth = () => {
      api('/health')
        .then((payload) => {
          if (cancelled) return
          const health = (payload as HealthPayload).rateLimiter
          setRateLimiterHealth(health ?? null)
          setRateLimiterCheckedAt(Date.now())
        })
        .catch(() => {
          if (cancelled) return
          // Keep the last successful snapshot visible. The checked-at timestamp
          // freezing is the staleness signal when a later /health poll fails.
        })
      // Live queue numbers intentionally stay off unauthenticated `/health`.
      // Poll the admin projection on the same cadence and preserve the last
      // successful snapshot if a later request fails.
      if (queueForbidden) return
      api('/system/queue')
        .then((payload) => {
          if (cancelled) return
          const health = parseQueueHealth(payload)
          setQueueSignal({
            health,
            unavailableReason: payload === null ? 'redis' : 'transport',
          })
          setQueueCheckedAt(Date.now())
        })
        .catch((error) => {
          if (cancelled) return
          if (isForbiddenApiError(error)) {
            queueForbidden = true
            setQueueSignal(undefined)
            setQueueCheckedAt(null)
            return
          }
          setQueueSignal(current => current ?? {
            health: null,
            unavailableReason: 'transport',
          })
        })
    }
    loadHealth()
    // Infrastructure health is independent of workflow saves — poll both
    // projections on a fixed cadence instead of refiring on every
    // platformVersion bump. A save no longer refetches it, and a Redis
    // degradation is still caught within the interval even while idle.
    const id = window.setInterval(loadHealth, 20_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  // Sandbox zeros render neutral (decision: an empty workspace is "no
  // signal", not a red emergency). No-op once any run is terminal.
  const displayMetrics = neutralizeSandboxZeros(metrics)

  // Derive Overview dot signal: any metric in the "unhealthy" band. We
  // skip approvalsPending because its severity reflects load, not breakage.
  // Inline (no useMemo) — 5 comparisons against a fixed-size set is cheap
  // and keeps the asymmetry with the inline rate-limiter checks small.
  const overviewUnhealthy = displayMetrics
    ? [displayMetrics.successRate, displayMetrics.mttr, displayMetrics.p95Latency, displayMetrics.replayRate, displayMetrics.costThisWindow]
        .some((m) => m.severity === 'unhealthy')
    : false
  const queueHealth = queueSignal === undefined ? undefined : queueSignal.health

  const signals: SignalSummary = {
    rateLimiter: rateLimiterHealth,
    queue: queueHealth,
    budgetBlocked,
    overviewUnhealthy,
  }

  return (
    <div className="we-operations-page">
      <OperationsHeader
        metrics={displayMetrics}
        loading={loading}
        error={error}
        rateLimiterHealth={rateLimiterHealth}
        rateLimiterCheckedAt={rateLimiterCheckedAt}
        queueHealth={queueHealth}
        queueCheckedAt={queueCheckedAt}
        queueUnavailableReason={queueSignal?.unavailableReason}
      />
      <div className="we-operations-page__body">
        <OperationsRail section={section} onChange={setSection} signals={signals} />
        <div className="we-operations-page__content" data-section={section}>
          {/* Lazy-mount: only the active sub-tab's cards exist in the DOM.
              Inactive sub-tabs never fire their per-card `useEffect` fetches,
              which is what cuts page-load API traffic from ~9 calls to ~2-3. */}
          {section === 'overview' && <OverviewSection metrics={displayMetrics} />}
          {section === 'reliability' && <ReliabilitySection />}
          {section === 'access' && <AccessSection />}
          {section === 'integrations' && <IntegrationsSection />}
        </div>
      </div>
    </div>
  )
}
function OperationsHeader({
  metrics,
  loading,
  error,
  rateLimiterHealth,
  rateLimiterCheckedAt,
  queueHealth,
  queueCheckedAt,
  queueUnavailableReason,
}: {
  metrics: RecoveryMetrics | null
  loading: boolean
  error: string | null
  rateLimiterHealth: RateLimiterHealth | null
  rateLimiterCheckedAt: number | null
  queueHealth: QueueHealth | null | undefined
  queueCheckedAt: number | null
  queueUnavailableReason?: QueueUnavailableReason
}) {
  const { t } = useT()
  return (
    <header className="we-operations-header">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{t('operations.kicker')}</div>
          <h2>{t('operations.title')}</h2>
          <p>{t('operations.intro', { days: metrics?.windowDays ?? 30 })}</p>
        </div>
        <span className="panel-heading-icon"><Gauge size={18} aria-hidden="true" /></span>
      </div>

      <div className="we-operations-header__signals">
        <RunStreamChip />
        {rateLimiterHealth && <RateLimiterStatusChip health={rateLimiterHealth} checkedAt={rateLimiterCheckedAt} />}
        {queueHealth !== undefined && (
          <QueueLagChip
            health={queueHealth}
            checkedAt={queueCheckedAt}
            unavailableReason={queueUnavailableReason}
          />
        )}
      </div>

      {error && (
        <section className="we-card">
          <p className="helper-text">{t('operations.metricsUnavailable', { detail: error })}</p>
        </section>
      )}

      {!error && (loading || !metrics) && (
        <section className="we-card">
          <p className="helper-text" aria-live="polite">{t('operations.computing')}</p>
        </section>
      )}

      {!error && metrics && (
        <VitalSignsStrip tiles={buildOperationsTiles(metrics, t)} />
      )}
    </header>
  )
}

const RAIL_ITEMS: Array<{ section: OpsSection; icon: React.ReactNode }> = [
  { section: 'overview', icon: <Gauge size={14} aria-hidden="true" /> },
  { section: 'reliability', icon: <RefreshCw size={14} aria-hidden="true" /> },
  { section: 'access', icon: <ShieldCheck size={14} aria-hidden="true" /> },
  { section: 'integrations', icon: <Plug size={14} aria-hidden="true" /> },
]

function OperationsRail({
  section,
  onChange,
  signals,
}: {
  section: OpsSection
  onChange: (next: OpsSection) => void
  signals: SignalSummary
}) {
  const { t } = useT()

  // Dot-badge derivation is intentionally limited to page-level signals.
  // Reading child-card health here would force those cards to fetch while
  // inactive, which would break the lazy-mount traffic reduction.
  const dotKind: Record<OpsSection, 'danger' | 'warning' | null> = {
    overview: signals.overviewUnhealthy ? 'warning' : null,
    reliability:
      signals.budgetBlocked != null
        ? 'danger'
        : signals.rateLimiter && !signals.rateLimiter.healthy
          ? 'warning'
          : signals.queue !== undefined && queueNeedsAttention(signals.queue)
            ? 'warning'
          : null,
    access: null,
    integrations: null,
  }

  return (
    <nav
      className="we-operations-rail"
      aria-label={t('operations.section.railLabel')}
      data-testid="operations-rail"
    >
      <ul>
        {RAIL_ITEMS.map((item) => {
          const isActive = item.section === section
          const dot = dotKind[item.section]
          return (
            <li key={item.section}>
              <button
                type="button"
                className="we-operations-rail__tab"
                aria-current={isActive ? 'page' : undefined}
                data-active={isActive ? 'true' : undefined}
                data-section={item.section}
                data-testid={`operations-rail-tab-${item.section}`}
                onClick={() => onChange(item.section)}
              >
                <span className="we-operations-rail__icon" aria-hidden="true">{item.icon}</span>
                <span className="we-operations-rail__label">
                  {t(`operations.section.${item.section}.label` as never)}
                </span>
                {dot && (
                  <span
                    className="we-operations-rail__dot"
                    data-severity={dot}
                    data-testid={`operations-rail-dot-${item.section}`}
                    aria-label={t('operations.section.attentionDot')}
                  />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function OverviewSection({ metrics }: { metrics: RecoveryMetrics | null }) {
  const { t } = useT()
  const locale = getResolvedLocale()
  return (
    <>
      {metrics && metrics.costThisWindow.providers.length > 0 && (
        <section className="we-card">
          <div className="section-kicker">{t('operations.cost.heading')}</div>
          <dl className="we-ops-cache-summary" aria-label={t('operations.cost.cache.summaryLabel')}>
            <div>
              <dt>{t('operations.cost.cache.readShare')}</dt>
              <dd>{metrics.costThisWindow.cache.readSharePercent == null
                ? '—'
                : `${metrics.costThisWindow.cache.readSharePercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`}</dd>
            </div>
            <div>
              <dt>{t('operations.cost.cache.readTokens')}</dt>
              <dd>{metrics.costThisWindow.cache.readTokens.toLocaleString(locale)}</dd>
            </div>
            <div>
              <dt>{t('operations.cost.cache.creationTokens')}</dt>
              <dd>{metrics.costThisWindow.cache.creationTokens.toLocaleString(locale)}</dd>
            </div>
          </dl>
          <div
            className="we-ops-cost-table-wrap"
            role="region"
            aria-label={t('operations.cost.tableAria')}
            tabIndex={0}
          >
            <table className="we-ops-cost-table">
              <thead>
                <tr>
                  <th>{t('operations.cost.col.provider')}</th>
                  <th>{t('operations.cost.col.model')}</th>
                  <th>{t('operations.cost.col.usd')}</th>
                  <th>{t('operations.cost.col.tokens')}</th>
                  <th>{t('operations.cost.col.cacheRead')}</th>
                  <th>{t('operations.cost.col.cacheCreated')}</th>
                  <th>{t('operations.cost.col.calls')}</th>
                </tr>
              </thead>
              <tbody>
                {metrics.costThisWindow.providers.map((row) => (
                  <tr key={`${row.aggregated ? 'aggregate' : 'detail'}::${row.provider}::${row.model}`}>
                    <td>{row.aggregated ? t('operations.cost.otherProviderModel') : row.provider}</td>
                    <td>{row.aggregated ? '—' : <code>{row.model}</code>}</td>
                    <td>${row.usd.toFixed(4)}</td>
                    <td>{row.tokens.toLocaleString(locale)}</td>
                    <td>{row.cachedInputTokens.toLocaleString(locale)}</td>
                    <td>{row.cacheCreationInputTokens.toLocaleString(locale)}</td>
                    <td>{row.calls.toLocaleString(locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <FailureClustersCard />
    </>
  )
}

function ReliabilitySection() {
  return (
    <>
      <AlertPoliciesPanel />
      <RecentAlertsCard />
      <UpstreamHealthPanel />
      <BudgetSettingsPanel />
      <AiGuidanceSettingsPanel />
    </>
  )
}

function AccessSection() {
  return (
    <>
      <AuthPolicySettingsPanel />
      <ScimDirectorySettingsPanel />
      <PermissionGrantsPanel />
      <MemoryGovernancePanel />
      <AuditLogPanel />
    </>
  )
}

function IntegrationsSection() {
  return (
    <>
      <CredentialHealthCard />
      <McpConnectionsPanel />
    </>
  )
}

/**
 * Status chip surfacing Redis-backed rate-limiter degradation. Kept in this
 * file so the Operations page stays self-contained.
 */
function RateLimiterStatusChip({ health, checkedAt }: { health: RateLimiterHealth; checkedAt?: number | null }) {
  const { t } = useT()
  // Absolute "Checked HH:MM:SS" of the last successful /health poll. No tick is
  // needed — the 20s poll re-renders with a fresh timestamp; a failed poll
  // leaves the last one frozen, which is the staleness signal.
  const checkedLabel = typeof checkedAt === 'number'
    ? (t('operations.rateLimiter.checkedAt', { time: new Date(checkedAt).toLocaleTimeString(getResolvedLocale()) }))
    : null
  const age = checkedLabel ? <span className="we-ops-rate-limiter-chip__age">· {checkedLabel}</span> : null
  if (health.healthy) {
    return (
      <span
        className="we-ops-rate-limiter-chip we-ops-rate-limiter-chip--healthy"
        role="status"
        aria-label={checkedLabel ? `${t('operations.rateLimiter.label')} · ${checkedLabel}` : (t('operations.rateLimiter.label'))}
      >
        <span className="we-ops-rate-limiter-chip__dot" aria-hidden="true" />
        <span>{t('operations.rateLimiter.healthy')}</span>
        {age}
      </span>
    )
  }
  const bucketCount = health.degradedBuckets.length
  const bucketNames = health.degradedBuckets.map((b) => b.bucket).join(', ')
  const tooltip = t('operations.rateLimiter.degradedBucketsTooltip', { buckets: bucketNames })
  return (
    <span
      className="we-ops-rate-limiter-chip we-ops-rate-limiter-chip--degraded"
      role="status"
      aria-label={checkedLabel ? `${t('operations.rateLimiter.label')} · ${checkedLabel}` : (t('operations.rateLimiter.label'))}
      title={tooltip}
    >
      <span className="we-ops-rate-limiter-chip__dot" aria-hidden="true" />
      <span>{t('operations.rateLimiter.degraded', { count: bucketCount })}</span>
      {age}
    </span>
  )
}
