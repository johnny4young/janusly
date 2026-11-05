/**
 * Settings workspace shell with a searchable index, focused sections, and an
 * active-only content column.
 *
 * Inactive sections do not render, so their self-fetching cards stay dormant.
 * The index exposes current posture first and routes operators to one focused
 * configuration area instead of presenting a wall of forms.
 *
 * The active sub-tab is spelled in the route (`#/operations/<section>`) and
 * mirrored to localStorage under `janusly:operations:section` so the operator
 * lands where they left off. A defensive `isSection()` guard collapses unknown
 * values back to `overview`.
 *
 * Wired into `RightPanel.tsx` for the `'operations'` tab — this shell owns
 * the mounted settings experience.
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import {
  BrainCircuit,
  Building2,
  ChartNoAxesCombined,
  LayoutGrid,
  Plug,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react'
import { api, contractApi, isForbiddenApiError } from '../api'
import { onRouteChange } from '../lib/route'
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
import {
  parseRecoveryMetrics,
  type RecoveryMetric,
  type RecoveryMetrics,
} from '../lib/recovery-metrics-model'
import {
  isOpsSection as isSection,
  loadStoredOpsSection as loadStoredSection,
  persistOpsSection as persistSection,
  requestOperationsSection,
  type OpsSection,
} from './operations-section-bus'
import { tRecoveryMetricRationale, useT } from '../i18n'
import type { Translate } from '../i18n/resources'
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


/** Why a rail section carries an attention dot; no entry means no dot. */
type DotReasons = Partial<Record<OpsSection, string>>

type QueueSignalState = {
  workflow: QueueHealth | null
  maintenance: QueueHealth | null | undefined
  workflowUnavailableReason: QueueUnavailableReason
  maintenanceUnavailableReason: QueueUnavailableReason
}

function unhealthyReason(metrics: readonly RecoveryMetric[]): string {
  return metrics
    .filter((metric) => metric.severity === 'unhealthy')
    .map((metric) => [metric.display, tRecoveryMetricRationale(metric)].filter(Boolean).join(' — '))
    .join(' ')
}

function queueIssue(
  prefix: 'operations.queueLag' | 'operations.maintenanceQueueLag',
  health: QueueHealth | null | undefined,
  unavailableReason: QueueUnavailableReason | undefined,
  t: Translate,
): string | null {
  if (health === undefined || !queueNeedsAttention(health)) return null
  if (health === null) return t(`${prefix}.${unavailableReason === 'transport' ? 'unavailableTransport' : 'unavailableStore'}`)
  return t(`${prefix}.${health.active > 0 ? 'delayedActiveStatus' : 'delayedIdleStatus'}`)
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

  // The URL owns the open pane: a typed link, Back and in-app requests all land
  // here. A hash naming no openable pane is rewritten to the one on screen.
  useEffect(() => onRouteChange((route) => {
    if (route?.tab !== 'operations') return
    if (isSection(route.opsSection) && canOpenSettingsSection(route.opsSection, permissions)) {
      setSection(route.opsSection)
      return
    }
    persistSection(effectiveSection)
  }), [effectiveSection, permissions])

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
  const operational = metrics && metrics.terminalRuns > 0 ? metrics : null
  const reliabilityReason = operational
    ? unhealthyReason([
        operational.successRate,
        operational.verifiedRecovery ?? operational.mttr,
        operational.p95Latency,
        operational.replayRate,
      ])
    : ''
  const usageReason = operational ? unhealthyReason([operational.costThisWindow]) : ''
  const queueHealth = queueSignal?.workflow
  const maintenanceQueueHealth = queueSignal?.maintenance
  const queued = (queueHealth?.waiting ?? 0) + (maintenanceQueueHealth?.waiting ?? 0)

  const infrastructureIssues = [
    rateLimiterHealth && !rateLimiterHealth.healthy
      ? t('operations.rateLimiter.degraded', { count: rateLimiterHealth.degradedBuckets.length })
      : null,
    queueIssue('operations.queueLag', queueHealth, queueSignal?.workflowUnavailableReason, t),
    queueIssue('operations.maintenanceQueueLag', maintenanceQueueHealth, queueSignal?.maintenanceUnavailableReason, t),
  ].filter((issue) => issue !== null).join(' ')

  // Dot-badge derivation is intentionally limited to page-level signals.
  // Reading child-card health here would force those cards to fetch while
  // inactive, which would break the lazy-mount traffic reduction.
  const dotReasons: DotReasons = {
    overview: [reliabilityReason, usageReason].filter(Boolean).join(' '),
    reliability: reliabilityReason,
    usage: usageReason,
    infrastructure: infrastructureIssues,
    ai: budgetBlocked
      ? t('budgetBanner.exceeded', {
          scope: t(budgetBlocked.exceededAt === 'workflow' ? 'budgetBanner.scope.workflow' : 'budgetBanner.scope.org'),
        })
      : '',
  }
  // A malformed payload parses to a neutral metric with a null value: no line, not "no usage".
  const usageStatus = !metrics || metrics.costThisWindow.value === null
    ? null
    : metrics.costThisWindow.providers.length === 0
      ? t('operations.status.usageNone', { days: metrics.windowDays })
      : t('operations.status.usage', { cost: metrics.costThisWindow.display, days: metrics.windowDays })
  const infrastructureStatus = infrastructureIssues
    || (queueHealth === undefined
      ? null
      : queued > 0
        ? t('operations.status.queued', { count: queued })
        : t('operations.status.queuesClear'))

  return (
    <div className="we-operations-page">
      <OperationsHeader
        windowDays={metrics?.windowDays ?? 30}
        error={error}
      />
      <div className="we-operations-page__body">
        <OperationsRail section={effectiveSection} onChange={requestOperationsSection} dotReasons={dotReasons} permissions={permissions} />
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
                usageStatus={usageStatus}
                infrastructureStatus={infrastructureStatus}
                onOpenSection={requestOperationsSection}
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
      <h2 className="we-sr-only">{t('operations.title')}</h2>
      <p className="we-operations-header__intro">{t('operations.intro', { days: windowDays })}</p>

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
  dotReasons,
  permissions,
}: {
  section: OpsSection
  onChange: (next: OpsSection) => void
  dotReasons: DotReasons
  permissions?: readonly string[]
}) {
  const { t } = useT()
  const visibleItems = RAIL_ITEMS.filter(({ section: candidate }) =>
    canOpenSettingsSection(candidate, permissions))

  return (
    <nav
      className="we-operations-rail"
      aria-label={t('operations.section.railLabel')}
      data-testid="operations-rail"
    >
      <ul>
        {visibleItems.map((item) => {
          const isActive = item.section === section
          const dotReason = dotReasons[item.section]
          return (
            <li key={item.section}>
              <button
                type="button"
                className="we-operations-rail__tab"
                aria-current={isActive ? 'page' : undefined}
                data-active={isActive ? 'true' : undefined}
                data-section={item.section}
                data-testid={`operations-rail-tab-${item.section}`}
                title={dotReason || undefined}
                onClick={() => onChange(item.section)}
              >
                <span className="we-operations-rail__icon" aria-hidden="true">{item.icon}</span>
                <span className="we-operations-rail__label">
                  {t(`operations.section.${item.section}.label`)}
                </span>
                {dotReason && (
                  <span
                    className="we-operations-rail__dot"
                    data-severity={item.section === 'ai' ? 'danger' : 'warning'}
                    data-testid={`operations-rail-dot-${item.section}`}
                    role="img"
                    aria-label={dotReason}
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
      {hasPermission(permissions, 'dlq.read') && <FailureClustersCard canStartRuns={hasPermission(permissions, 'runs.start')} />}
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
