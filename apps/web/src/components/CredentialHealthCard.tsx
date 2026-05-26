/**
 * Credential health card surfaced in `OperationsPanel`. Polls
 * `GET /credentials/health` on the existing `platformVersion`
 * cadence and renders two compact sub-lists (credentials + MCP
 * connections) with severity-tinted rows.
 *
 * The card is observability-only: no admin actions live here.
 * Rediscover for stale MCP connections stays in the existing
 * `McpConnectionsPanel`; the copy in the empty-action cell points
 * the operator there.
 *
 * Load-bearing properties (mirrored on the server):
 * - The bucket / credential / connection NAMES are operator-chosen
 *   identifiers; the env-var values they map to NEVER reach the
 *   wire and never reach this component.
 * - `lastErrorMessage` is server-scrubbed via `scrubSecretShapes`.
 */

import React, { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, useT } from '../i18n'

type CredentialEntry = {
  id: string
  name: string
  kind: string
  secretRefPresent: boolean
  lastUsedAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
  usageCount30d: number
  referencingWorkflowIds: string[]
}

type McpConnectionEntry = {
  alias: string
  status: 'pending' | 'active' | 'failed' | 'disabled'
  statusReason: string | null
  lastDiscoveryAt: string | null
  staleDays: number | null
  toolCount: number
  enabledToolCount: number
  lastUsedAt: string | null
  envRefsMissingKeys: string[]
  referencingWorkflowIds: string[]
}

type CredentialHealthPayload = {
  credentials: CredentialEntry[]
  mcpConnections: McpConnectionEntry[]
  generatedAt: string
}

type Severity = 'healthy' | 'warn' | 'unhealthy'

/** Stale-discovery threshold in days — above this, the row paints amber. */
const STALE_DISCOVERY_DAYS = 7
/** Recent-error window in milliseconds. Errors older than this don't tint. */
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

function severityForCredential(entry: CredentialEntry): Severity {
  if (!entry.secretRefPresent) return 'unhealthy'
  if (entry.lastErrorAt) {
    const ts = new Date(entry.lastErrorAt).getTime()
    if (Date.now() - ts < RECENT_ERROR_WINDOW_MS) return 'warn'
  }
  return 'healthy'
}

function severityForMcp(entry: McpConnectionEntry): Severity {
  if (entry.status === 'failed') return 'unhealthy'
  if (entry.envRefsMissingKeys.length > 0) return 'unhealthy'
  if (entry.status === 'disabled') return 'warn'
  if (entry.staleDays !== null && entry.staleDays > STALE_DISCOVERY_DAYS) return 'warn'
  return 'healthy'
}

function formatRelative(isoTimestamp: string | null): string {
  if (!isoTimestamp) return '—'
  const then = new Date(isoTimestamp).getTime()
  if (Number.isNaN(then)) return '—'
  const deltaMs = Date.now() - then
  const fmt = new Intl.RelativeTimeFormat(getResolvedLocale(), { numeric: 'auto' })
  const seconds = Math.round(-deltaMs / 1000)
  const absSeconds = Math.abs(seconds)
  if (absSeconds < 60) return fmt.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return fmt.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return fmt.format(hours, 'hour')
  const days = Math.round(hours / 24)
  return fmt.format(days, 'day')
}

export function CredentialHealthCard() {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [payload, setPayload] = useState<CredentialHealthPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api('/credentials/health')
      .then((res) => {
        if (cancelled) return
        // Defensive: tolerate the rare case where the API returns an
        // unexpected shape (older replica, transient body, etc.). We
        // normalize to the canonical type so downstream `.length` reads
        // never throw and the chip degrades silently to "empty".
        const raw = (res ?? {}) as Partial<CredentialHealthPayload>
        setPayload({
          credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
          mcpConnections: Array.isArray(raw.mcpConnections) ? raw.mcpConnections : [],
          generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [platformVersion])

  if (error) {
    return (
      <section className="panel-card we-ops-credential-card" aria-label={t('operations.credentialHealth.title') as string}>
        <div className="we-ops-credential-card__section">
          <div className="section-kicker">{t('operations.credentialHealth.kicker')}</div>
          <h3 style={{ margin: 0 }}>{t('operations.credentialHealth.title')}</h3>
          <p className="helper-text">{t('operations.credentialHealth.unavailable', { detail: error })}</p>
        </div>
      </section>
    )
  }

  if (!payload) return null

  const isEmpty = payload.credentials.length === 0 && payload.mcpConnections.length === 0

  const credentialSeverities = payload.credentials.map(severityForCredential)
  const mcpSeverities = payload.mcpConnections.map(severityForMcp)
  const cardSeverity: 'danger' | 'warning' | undefined =
    credentialSeverities.includes('unhealthy') || mcpSeverities.includes('unhealthy')
      ? 'danger'
      : credentialSeverities.includes('warn') || mcpSeverities.includes('warn')
        ? 'warning'
        : undefined

  return (
    <section
      className="panel-card we-ops-credential-card"
      data-severity={cardSeverity}
      aria-label={t('operations.credentialHealth.title') as string}
    >
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <div className="section-kicker">{t('operations.credentialHealth.kicker')}</div>
          <h3 style={{ margin: 0 }}>{t('operations.credentialHealth.title')}</h3>
          <p className="helper-text">{t('operations.credentialHealth.intro')}</p>
        </div>
        <span className="panel-heading-icon"><ShieldCheck size={16} aria-hidden="true" /></span>
      </div>

      {isEmpty && (
        <EmptyState
          icon={<KeyRound />}
          kicker={t('emptyState.credentials.kicker') as string}
          body={t('emptyState.credentials.body') as string}
          testId="credentials-empty"
        />
      )}

      {payload.credentials.length > 0 && (
        <div className="we-ops-credential-card__section">
          <h4 className="we-ops-credential-card__section-heading">{t('operations.credentialHealth.credentials.heading')}</h4>
          <ul className="we-ops-credential-card__list">
            {payload.credentials.map((entry) => {
              const severity = severityForCredential(entry)
              const statusLabel = !entry.secretRefPresent
                ? (t('operations.credentialHealth.status.missing') as string)
                : severity === 'warn'
                  ? (t('operations.credentialHealth.status.recentError') as string)
                  : (t('operations.credentialHealth.status.healthy') as string)
              return (
                <li key={entry.id} className={`we-ops-credential-card__row we-ops-credential-card__row--${severity}`}>
                  <div className="we-ops-credential-card__row-name" title={`${entry.name} · ${entry.kind}`}>
                    <strong>{entry.name}</strong> <span className="we-ops-credential-card__row-meta">· {entry.kind}</span>
                  </div>
                  <div className={`we-ops-credential-card__row-status we-ops-credential-card__row-status--${severity}`}>
                    {statusLabel}
                  </div>
                  <div className="we-ops-credential-card__row-meta">
                    {t('operations.credentialHealth.col.lastUsed')}: {formatRelative(entry.lastUsedAt)}
                    {entry.referencingWorkflowIds.length > 0 && (
                      <> · {t('operations.credentialHealth.col.usedIn', { count: entry.referencingWorkflowIds.length })}</>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {payload.mcpConnections.length > 0 && (
        <div className="we-ops-credential-card__section">
          <h4 className="we-ops-credential-card__section-heading">{t('operations.credentialHealth.mcp.heading')}</h4>
          <ul className="we-ops-credential-card__list">
            {payload.mcpConnections.map((entry) => {
              const severity = severityForMcp(entry)
              const isStale = entry.staleDays !== null && entry.staleDays > STALE_DISCOVERY_DAYS
              const isMissingRefs = entry.envRefsMissingKeys.length > 0
              const statusLabel = isMissingRefs
                ? (t('operations.credentialHealth.status.missing') as string)
                : isStale
                  ? (t('operations.credentialHealth.status.staleMcp') as string)
                  : (t('operations.credentialHealth.status.healthy') as string)
              const meta: string[] = []
              if (isStale && entry.staleDays !== null) {
                meta.push(t('operations.credentialHealth.staleDays', { count: entry.staleDays }) as string)
              }
              if (isMissingRefs) {
                meta.push(t('operations.credentialHealth.mcpMissingEnvRefs', { count: entry.envRefsMissingKeys.length }) as string)
              }
              return (
                <li key={entry.alias} className={`we-ops-credential-card__row we-ops-credential-card__row--${severity}`}>
                  <div className="we-ops-credential-card__row-name">
                    <strong>{entry.alias}</strong>{' '}
                    <span className="we-ops-credential-card__row-meta">· {t('operations.credentialHealth.mcpToolsSummary', { enabled: entry.enabledToolCount, total: entry.toolCount })}</span>
                  </div>
                  <div className={`we-ops-credential-card__row-status we-ops-credential-card__row-status--${severity}`}>
                    {statusLabel}
                  </div>
                  <div className="we-ops-credential-card__row-meta">
                    {meta.length > 0 ? meta.join(' · ') : `${t('operations.credentialHealth.col.lastUsed')}: ${formatRelative(entry.lastUsedAt)}`}
                  </div>
                </li>
              )
            })}
          </ul>
          {payload.mcpConnections.some((c) => c.staleDays !== null && c.staleDays > STALE_DISCOVERY_DAYS) && (
            <p className="helper-text" style={{ marginTop: 8 }}>{t('operations.credentialHealth.rediscoverHint')}</p>
          )}
        </div>
      )}
    </section>
  )
}
