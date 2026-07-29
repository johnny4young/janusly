/**
 * Settings workspace shell with a searchable index, focused sections, and an
 * active-only content column.
 *
 * Inactive sections do not render, so their self-fetching cards stay dormant.
 * The index exposes current posture first and routes operators to one focused
 * configuration area instead of presenting a wall of forms.
 *
 * Active sub-tab is persisted to localStorage under
 * `janusly:operations:section` so the operator lands where they left
 * off. A defensive `isSection()` guard collapses unknown values back to
 * `overview` — same posture as `BuilderSidebar`'s stored-state loader.
 *
 * Wired into `RightPanel.tsx` for the `'operations'` tab — this shell owns
 * the mounted operations experience.
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import {
  BrainCircuit,
  ChartNoAxesCombined,
  Gauge,
  LayoutGrid,
  Plug,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react'
import { api } from '../api'
import { canOpenSettingsSection } from '../settings-sections'
import { useWorkflowStore } from '../store'
import type { ActiveTab, AiHealth } from '../types'
import {
  parseQueueHealthOverview,
  queueNeedsAttention,
  type QueueHealth,
  type QueueUnavailableReason,
} from './QueueLagChip'
import { AiRuntimeStatusCard } from './AiRuntimeStatusCard'
import { SettingsInfrastructureSection } from './SettingsInfrastructureSection'
import { SettingsOverview } from './SettingsOverview'
import {
  SettingsUsageSection,
  type CacheEfficiency,
  type CostProviderRow,
} from './SettingsUsageSection'
import {
  OPERATIONS_SECTION_REQUEST_EVENT as SECTION_REQUEST_EVENT,
  isOpsSection as isSection,
  loadStoredOpsSection as loadStoredSection,
  persistOpsSection as persistSection,
  type OpsSection,
} from './operations-section-bus'
import { useT } from '../i18n'

const FailureClustersCard = lazy(() => import('./FailureClustersCard').then(module => ({ default: module.FailureClustersCard })))
const BudgetSettingsPanel = lazy(() => import('./BudgetSettingsPanel').then(module => ({ default: module.BudgetSettingsPanel })))
const AiGuidanceSettingsPanel = lazy(() => import('./AiGuidanceSettingsPanel').then(module => ({ default: module.AiGuidanceSettingsPanel })))
const AuthPolicySettingsPanel = lazy(() => import('./AuthPolicySettingsPanel').then(module => ({ default: module.AuthPolicySettingsPanel })))
const ScimDirectorySettingsPanel = lazy(() => import('./ScimDirectorySettingsPanel').then(module => ({ default: module.ScimDirectorySettingsPanel })))
const AuditLogPanel = lazy(() => import('./AuditLogPanel').then(module => ({ default: module.AuditLogPanel })))
const PermissionGrantsPanel = lazy(() => import('./PermissionGrantsPanel').then(module => ({ default: module.PermissionGrantsPanel })))
const MemoryGovernancePanel = lazy(() => import('./MemoryGovernancePanel').then(module => ({ default: module.MemoryGovernancePanel })))
const AlertPoliciesPanel = lazy(() => import('./AlertPoliciesPanel').then(module => ({ default: module.AlertPoliciesPanel })))
const UpstreamHealthPanel = lazy(() => import('./UpstreamHealthPanel').then(module => ({ default: module.UpstreamHealthPanel })))
const RecentAlertsCard = lazy(() => import('./RecentAlertsCard').then(module => ({ default: module.RecentAlertsCard })))
const McpConnectionsPanel = lazy(() => import('./McpConnectionsPanel').then(module => ({ default: module.McpConnectionsPanel })))
const SlackInteractionsPanel = lazy(() => import('./SlackInteractionsPanel').then(module => ({ default: module.SlackInteractionsPanel })))
const ExternalRuntimePanel = lazy(() => import('./ExternalRuntimePanel').then(module => ({ default: module.ExternalRuntimePanel })))

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

type RecoveryMetrics = {
  successRate: RecoveryMetric
  verifiedRecovery?: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  slaAttainment?: RecoveryMetric
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[]; cache: CacheEfficiency }
  windowDays: number
  terminalRuns: number
}

// The section bus (sub-section enum + deep-link helper) lives in its own
// module so OperationsPage stays code-splittable — see operations-section-bus.
// Re-exported here for back-compat with existing `from './OperationsPage'`
// callers; new callers should import from the bus directly.
export { requestOperationsSection } from './operations-section-bus'
export type { OpsSection } from './operations-section-bus'

type SignalSummary = {
  /** `/health` rate-limiter snapshot. Drives the chip and Infrastructure dot. */
  rateLimiter: RateLimiterHealth | null
  /** Admin queue snapshot; null means unavailable, undefined means not checked yet. */
  queue: QueueHealth | null | undefined
  /** Independent maintenance queue snapshot; absent against an older API. */
  maintenanceQueue: QueueHealth | null | undefined
  /** Most recent 402 envelope captured by the API wrapper. Drives the AI dot. */
  budgetBlocked: unknown
  /** True when any high-level metric is unhealthy. Drives the overview dot. */
  overviewUnhealthy: boolean
  /** True when a reliability metric is unhealthy. */
  reliabilityUnhealthy: boolean
  /** True when cost posture is unhealthy. */
  usageUnhealthy: boolean
}

type QueueSignalState = {
  workflow: QueueHealth | null
  maintenance: QueueHealth | null | undefined
  workflowUnavailableReason: QueueUnavailableReason
  maintenanceUnavailableReason: QueueUnavailableReason
}

function hasNullMaintenanceSnapshot(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'maintenance' in value
    && (value as { maintenance?: unknown }).maintenance === null
}

function isForbiddenApiError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && (error as { statusCode?: unknown }).statusCode === 403
}

function hasPermission(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission)
}

export function OperationsPage({
  permissions,
  connectionCount = 0,
  aiHealth = null,
  onOpenTab = () => undefined,
}: {
  permissions?: readonly string[]
  connectionCount?: number
  aiHealth?: AiHealth | null
  onOpenTab?: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const budgetBlocked = useWorkflowStore((state) => state.budgetBlocked)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Rate-limiter health is independent of metrics and degrades silently on
  // /health failure — operators still see the rest of the page.
  const [rateLimiterHealth, setRateLimiterHealth] = useState<RateLimiterHealth | null>(null)
  const [queueSignal, setQueueSignal] = useState<QueueSignalState | undefined>(undefined)
  const [queueCheckedAt, setQueueCheckedAt] = useState<number | null>(null)
  const [section, setSection] = useState<OpsSection>(() => loadStoredSection())
  const effectiveSection = canOpenSettingsSection(section, permissions)
    ? section
    : RAIL_ITEMS.find((item) => canOpenSettingsSection(item.section, permissions))?.section
      ?? 'overview'

  useEffect(() => {
    if (section !== effectiveSection) setSection(effectiveSection)
  }, [effectiveSection, section])

  // Persist on every section change. Tiny write — no debounce needed.
  useEffect(() => {
    persistSection(effectiveSection)
  }, [effectiveSection])

  useEffect(() => {
    const handleSectionRequest = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null
      if (!isSection(next)) return
      if (canOpenSettingsSection(next, permissions)) {
        setSection(next)
        return
      }
      persistSection(effectiveSection)
    }
    window.addEventListener(SECTION_REQUEST_EVENT, handleSectionRequest)
    return () => window.removeEventListener(SECTION_REQUEST_EVENT, handleSectionRequest)
  }, [effectiveSection, permissions])

  useEffect(() => {
    let cancelled = false
    setError(null)
    if (!hasPermission(permissions, 'recovery.read')) {
      setMetrics(null)
      return () => { cancelled = true }
    }
    api('/recovery/metrics')
      .then((payload) => {
        if (cancelled) return
        setMetrics(payload as RecoveryMetrics)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : (t('operations.metricsUnavailable', { detail: '' })))
      })
    return () => { cancelled = true }
  }, [permissions, platformVersion, t])

  useEffect(() => {
    let cancelled = false
    let queueForbidden = false
    const loadHealth = () => {
      api('/health')
        .then((payload) => {
          if (cancelled) return
          const health = (payload as HealthPayload).rateLimiter
          setRateLimiterHealth(health ?? null)
        })
        .catch(() => {
          if (cancelled) return
          // Keep the last successful snapshot visible. The checked-at timestamp
          // freezing is the staleness signal when a later /health poll fails.
        })
      // Live queue numbers intentionally stay off unauthenticated `/health`.
      // Poll the admin projection on the same cadence and preserve the last
      // successful snapshot if a later request fails.
      if (queueForbidden || !hasPermission(permissions, 'org.config.write')) return
      api('/system/queue')
        .then((payload) => {
          if (cancelled) return
          const health = parseQueueHealthOverview(payload)
          setQueueSignal({
            workflow: health.workflow,
            maintenance: health.maintenance,
            workflowUnavailableReason: payload === null ? 'redis' : 'transport',
            maintenanceUnavailableReason: hasNullMaintenanceSnapshot(payload) ? 'redis' : 'transport',
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
            workflow: null,
            maintenance: null,
            workflowUnavailableReason: 'transport',
            maintenanceUnavailableReason: 'transport',
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
  }, [permissions])

  // Empty workspaces have no operational signal, so server-side zero bands do
  // not raise attention dots until a run reaches a terminal state.
  const hasOperationalSignal = (metrics?.terminalRuns ?? 0) > 0
  const reliabilityUnhealthy = metrics && hasOperationalSignal
    ? [
        metrics.successRate,
        metrics.verifiedRecovery ?? metrics.mttr,
        metrics.p95Latency,
        metrics.replayRate,
      ].some((metric) => metric.severity === 'unhealthy')
    : false
  const usageUnhealthy = hasOperationalSignal && metrics?.costThisWindow.severity === 'unhealthy'
  const overviewUnhealthy = reliabilityUnhealthy || usageUnhealthy
  const queueHealth = queueSignal === undefined ? undefined : queueSignal.workflow
  const maintenanceQueueHealth = queueSignal === undefined ? undefined : queueSignal.maintenance

  const signals: SignalSummary = {
    rateLimiter: rateLimiterHealth,
    queue: queueHealth,
    maintenanceQueue: maintenanceQueueHealth,
    budgetBlocked,
    overviewUnhealthy,
    reliabilityUnhealthy,
    usageUnhealthy,
  }
  return (
    <div className="we-operations-page">
      <OperationsHeader
        windowDays={metrics?.windowDays ?? 30}
        error={error}
      />
      <div className="we-operations-page__body">
        <OperationsRail section={effectiveSection} onChange={setSection} signals={signals} permissions={permissions} />
        <div className="we-operations-page__content" data-section={effectiveSection}>
          <Suspense fallback={<p className="helper-text" role="status">{t('common.working')}</p>}>
            {effectiveSection === 'overview' && (
              <SettingsOverview
                permissions={permissions}
                connectionCount={connectionCount}
                aiHealth={aiHealth}
                onOpenSection={setSection}
                onOpenTab={onOpenTab}
              />
            )}
            {effectiveSection === 'reliability' && <ReliabilitySection permissions={permissions} />}
            {effectiveSection === 'integrations' && (
              <IntegrationsSection permissions={permissions} onOpenTab={onOpenTab} />
            )}
            {effectiveSection === 'access' && <AccessSection permissions={permissions} />}
            {effectiveSection === 'ai' && <AiSection permissions={permissions} aiHealth={aiHealth} />}
            {effectiveSection === 'usage' && (
              <SettingsUsageSection
                providers={metrics?.costThisWindow.providers ?? []}
                cache={metrics?.costThisWindow.cache ?? {
                  inputTokens: 0,
                  readTokens: 0,
                  creationTokens: 0,
                  readSharePercent: null,
                }}
              />
            )}
            {effectiveSection === 'infrastructure' && (
              <SettingsInfrastructureSection
                rateLimiterHealth={rateLimiterHealth}
                queueHealth={queueHealth}
                maintenanceQueueHealth={maintenanceQueueHealth}
                queueCheckedAt={queueCheckedAt}
                queueUnavailableReason={queueSignal?.workflowUnavailableReason}
                maintenanceQueueUnavailableReason={queueSignal?.maintenanceUnavailableReason}
              />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  )
}
function OperationsHeader({
  windowDays,
  error,
}: {
  windowDays: number
  error: string | null
}) {
  const { t } = useT()
  return (
    <header className="we-operations-header">
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{t('operations.kicker')}</div>
          <h2>{t('operations.title')}</h2>
          <p>{t('operations.intro', { days: windowDays })}</p>
        </div>
        <span className="panel-heading-icon"><Gauge size={18} aria-hidden="true" /></span>
      </div>

      {error && (
        <section className="we-card">
          <p className="helper-text">{t('operations.metricsUnavailable', { detail: error })}</p>
        </section>
      )}

    </header>
  )
}

const RAIL_ITEMS: Array<{ section: OpsSection; icon: ReactNode }> = [
  { section: 'overview', icon: <LayoutGrid size={14} aria-hidden="true" /> },
  { section: 'reliability', icon: <RefreshCw size={14} aria-hidden="true" /> },
  { section: 'integrations', icon: <Plug size={14} aria-hidden="true" /> },
  { section: 'access', icon: <ShieldCheck size={14} aria-hidden="true" /> },
  { section: 'ai', icon: <BrainCircuit size={14} aria-hidden="true" /> },
  { section: 'usage', icon: <ChartNoAxesCombined size={14} aria-hidden="true" /> },
  { section: 'infrastructure', icon: <ServerCog size={14} aria-hidden="true" /> },
]

function OperationsRail({
  section,
  onChange,
  signals,
  permissions,
}: {
  section: OpsSection
  onChange: (next: OpsSection) => void
  signals: SignalSummary
  permissions?: readonly string[]
}) {
  const { t } = useT()
  const visibleItems = RAIL_ITEMS.filter(({ section: candidate }) =>
    canOpenSettingsSection(candidate, permissions))

  // Dot-badge derivation is intentionally limited to page-level signals.
  // Reading child-card health here would force those cards to fetch while
  // inactive, which would break the lazy-mount traffic reduction.
  const queueAttention = (signals.queue !== undefined && queueNeedsAttention(signals.queue))
    || (signals.maintenanceQueue !== undefined
      && queueNeedsAttention(signals.maintenanceQueue))
  const dotKind: Record<OpsSection, 'danger' | 'warning' | null> = {
    overview: signals.overviewUnhealthy ? 'warning' : null,
    reliability: signals.reliabilityUnhealthy ? 'warning' : null,
    integrations: null,
    access: null,
    ai: signals.budgetBlocked != null ? 'danger' : null,
    usage: signals.usageUnhealthy ? 'warning' : null,
    infrastructure:
      signals.rateLimiter && !signals.rateLimiter.healthy
        ? 'warning'
        : queueAttention
          ? 'warning'
          : null,
  }

  return (
    <nav
      className="we-operations-rail"
      aria-label={t('operations.section.railLabel')}
      data-testid="operations-rail"
    >
      <ul>
        {visibleItems.map((item) => {
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
                  {t(`operations.section.${item.section}.label`)}
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

function ReliabilitySection({ permissions }: { permissions?: readonly string[] }) {
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  return (
    <>
      {can('alerts.read') && <AlertPoliciesPanel canWrite={can('alerts.write')} />}
      {can('alerts.read') && <RecentAlertsCard />}
      {can('upstream.read') && <UpstreamHealthPanel canWrite={can('upstream.write')} />}
      {can('dlq.read') && <FailureClustersCard />}
    </>
  )
}

function AccessSection({ permissions }: { permissions?: readonly string[] }) {
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  return (
    <>
      {can('org.config.write') && <AuthPolicySettingsPanel />}
      {can('members.read') && (
        <ScimDirectorySettingsPanel
          canConfigureDirectory={can('org.config.write')}
          canSetRoles={can('members.role_set')}
        />
      )}
      {can('members.read') && <PermissionGrantsPanel canWrite={can('org.permissions.write')} />}
      {can('recovery.read') && <MemoryGovernancePanel />}
      {can('org.config.write') && <AuditLogPanel />}
    </>
  )
}

function IntegrationsSection({
  permissions,
  onOpenTab,
}: {
  permissions?: readonly string[]
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  return (
    <>
      {can('credentials.read') && (
        <section className="we-card">
          <div className="we-card__header">
            <div>
              <strong>{t('workspace.section.credentials.label')}</strong>
              <p className="helper-text">{t('workspace.section.credentials.helper')}</p>
            </div>
            <button type="button" className="small-command" onClick={() => onOpenTab('credentials')}>
              {t('workspace.section.credentials.label')}
            </button>
          </div>
        </section>
      )}
      {can('external-runtimes.read') && (
        <ExternalRuntimePanel canWrite={can('external-runtimes.write')} />
      )}
      {can('credentials.write') && <SlackInteractionsPanel />}
      {can('mcp.connections.read') && <McpConnectionsPanel canWrite={can('mcp.connections.write')} />}
    </>
  )
}

function AiSection({
  permissions,
  aiHealth,
}: {
  permissions?: readonly string[]
  aiHealth: AiHealth | null
}) {
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  return (
    <>
      <AiRuntimeStatusCard health={aiHealth} />
      {can('org.config.write') && <BudgetSettingsPanel />}
      {can('org.config.write') && <AiGuidanceSettingsPanel />}
    </>
  )
}
