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
 * the mounted settings experience.
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import {
  BrainCircuit,
  Building2,
  ChartNoAxesCombined,
  Gauge,
  LayoutGrid,
  Plug,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react'
import { api, contractApi, isForbiddenApiError } from '../api'
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
import { SettingsInfrastructureSection, type WorkerFleet } from './SettingsInfrastructureSection'
import { SettingsOverview } from './SettingsOverview'
import { SettingsUsageSection } from './SettingsUsageSection'
import { parseRecoveryMetrics, type RecoveryMetrics } from '../lib/recovery-metrics-model'
import {
  OPERATIONS_SECTION_REQUEST_EVENT as SECTION_REQUEST_EVENT,
  isOpsSection as isSection,
  loadStoredOpsSection as loadStoredSection,
  persistOpsSection as persistSection,
  type OpsSection,
} from './operations-section-bus'
import { useT } from '../i18n'
import './OperationsPage.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { Button } from './ui/Button'
import { isGetRecoveryMetricsResponse } from '../lib/api-guards/operations/GetRecoveryMetrics'
import { MalformedResponseError } from '../lib/malformed-response'

const OPERATIONS_TAGS = [PLATFORM_TAG, 'health', 'org-config', 'runs'] as const

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
 *  the public rate-limiter health response from ``internal/ratelimit``
 *  byte-for-byte. Truncated server-side so internal store error text +
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

function hasPermission(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission)
}

export function OperationsPage({
  permissions,
  aiHealth = null,
  onOpenTab = () => undefined,
}: {
  permissions?: readonly string[]
  aiHealth?: AiHealth | null
  onOpenTab?: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const platformVersion = useInvalidationNonce(OPERATIONS_TAGS)
  const budgetBlocked = useWorkflowStore((state) => state.budgetBlocked)
  const [metrics, setMetrics] = useState<RecoveryMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Rate-limiter health is independent of metrics and degrades silently on
  // /health failure — operators still see the rest of the page.
  const [rateLimiterHealth, setRateLimiterHealth] = useState<RateLimiterHealth | null>(null)
  const [queueSignal, setQueueSignal] = useState<QueueSignalState | undefined>(undefined)
  const [queueCheckedAt, setQueueCheckedAt] = useState<number | null>(null)
  const [workerFleet, setWorkerFleet] = useState<WorkerFleet | null>(null)
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
    contractApi('GET /recovery/metrics', '/recovery/metrics', undefined, { guard: isGetRecoveryMetricsResponse })
      .then((payload) => {
        if (cancelled) return
        // A payload we cannot read is the same as no metrics: the page
        // already renders the unavailable state for `null`, and never again
        // dereferences `costThisWindow` on a shape the contract did not send.
        setMetrics(parseRecoveryMetrics(payload))
      })
      .catch((err) => {
        if (cancelled) return
        // An unreadable payload is the same as no metrics: the page's quiet unavailable state.
        if (err instanceof MalformedResponseError) {
          setMetrics(null)
          return
        }
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
      api('/system/workers')
        .then((payload) => {
          if (cancelled) return
          const body = payload as { status?: 'healthy' | 'degraded' | 'unhealthy' } | null
          if (!body || !['healthy', 'degraded', 'unhealthy'].includes(body.status ?? '')) {
            setWorkerFleet(null)
            return
          }
          setWorkerFleet({ status: body.status! })
        })
        .catch(() => {
          // Same posture as the queue chips: keep the last good snapshot.
        })
      api('/system/queue')
        .then((payload) => {
          if (cancelled) return
          const health = parseQueueHealthOverview(payload)
          setQueueSignal({
            workflow: health.workflow,
            maintenance: health.maintenance,
            // The request resolved: a missing projection here is the queue
            // store's absence (or a shape we could not read), never transport.
            // Transport is what the catch branch below reports.
            workflowUnavailableReason: 'store',
            maintenanceUnavailableReason: 'store',
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
    // platformVersion bump. A save no longer refetches it, and a queue-store
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
          {effectiveSection !== 'overview' && (
            <header className="we-card__header">
              <h3>{t(`operations.section.${effectiveSection}.label`)}</h3>
            </header>
          )}
          <Suspense fallback={<p className="helper-text" role="status">{t('common.working')}</p>}>
            {effectiveSection === 'overview' && (
              <SettingsOverview
                permissions={permissions}
                aiHealth={aiHealth}
                onOpenSection={setSection}
                onOpenTab={onOpenTab}
              />
            )}
            {effectiveSection === 'reliability' && <ReliabilitySection permissions={permissions} />}
            {effectiveSection === 'organization' && <OrganizationSection permissions={permissions} />}
            {effectiveSection === 'integrations' && (
              <ConnectionsSection permissions={permissions} onOpenTab={onOpenTab} />
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
                workerFleet={workerFleet}
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
  { section: 'organization', icon: <Building2 size={14} aria-hidden="true" /> },
  { section: 'access', icon: <ShieldCheck size={14} aria-hidden="true" /> },
  { section: 'integrations', icon: <Plug size={14} aria-hidden="true" /> },
  { section: 'ai', icon: <BrainCircuit size={14} aria-hidden="true" /> },
  { section: 'reliability', icon: <RefreshCw size={14} aria-hidden="true" /> },
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
    organization: null,
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
  return (
    <>
      {hasPermission(permissions, 'alerts.read') && (
        <AlertPoliciesPanel canWrite={hasPermission(permissions, 'alerts.write')} />
      )}
      {hasPermission(permissions, 'alerts.read') && <RecentAlertsCard />}
      {hasPermission(permissions, 'upstream.read') && (
        <UpstreamHealthPanel canWrite={hasPermission(permissions, 'upstream.write')} />
      )}
      {hasPermission(permissions, 'dlq.read') && <FailureClustersCard />}
    </>
  )
}

function AccessSection({ permissions }: { permissions?: readonly string[] }) {
  return (
    <>
      {hasPermission(permissions, 'org.config.write') && <AuthPolicySettingsPanel />}
      {hasPermission(permissions, 'members.read') && (
        <ScimDirectorySettingsPanel
          canConfigureDirectory={hasPermission(permissions, 'org.config.write')}
          canSetRoles={hasPermission(permissions, 'members.role_set')}
        />
      )}
      {hasPermission(permissions, 'members.read') && (
        <PermissionGrantsPanel canWrite={hasPermission(permissions, 'org.permissions.write')} />
      )}
    </>
  )
}

function OrganizationSection({ permissions }: { permissions?: readonly string[] }) {
  return (
    <>
      {hasPermission(permissions, 'recovery.read') && <MemoryGovernancePanel />}
      {hasPermission(permissions, 'org.config.write') && <AuditLogPanel />}
    </>
  )
}

function ConnectionsSection({
  permissions,
  onOpenTab,
}: {
  permissions?: readonly string[]
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <>
      {hasPermission(permissions, 'credentials.read') && (
        <section className="we-card">
          <div className="we-card__header">
            <p className="helper-text">{t('workspace.section.credentials.helper')}</p>
            <Button size="sm" onClick={() => onOpenTab('credentials')}>
              {t('palette.group.open')} {t('workspace.section.credentials.label')}
            </Button>
          </div>
        </section>
      )}
      {hasPermission(permissions, 'external-runtimes.read') && (
        <ExternalRuntimePanel canWrite={hasPermission(permissions, 'external-runtimes.write')} />
      )}
      {hasPermission(permissions, 'credentials.write') && <SlackInteractionsPanel />}
      {hasPermission(permissions, 'mcp.connections.read') && (
        <McpConnectionsPanel canWrite={hasPermission(permissions, 'mcp.connections.write')} />
      )}
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
  return (
    <>
      <AiRuntimeStatusCard health={aiHealth} />
      {hasPermission(permissions, 'org.config.write') && <BudgetSettingsPanel />}
      {hasPermission(permissions, 'org.config.write') && <AiGuidanceSettingsPanel />}
    </>
  )
}
