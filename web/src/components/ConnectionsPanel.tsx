import {
  AlertCircle,
  KeyRound,
  Plus,
  Search,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { api } from '../api'
import {
  credentialHealthState,
  filterCredentials,
  knownWorkflowReferences,
  listCredentialKinds,
  summarizeCredentialHealth,
  type CredentialHealthSnapshot,
} from '../connections-inventory'
import { expiryStatus } from '../credential-expiry'
import { DOCS_URL } from '../docs-link'
import { useVirtualList } from '../hooks/useVirtualList'
import { getResolvedLocale, useT } from '../i18n'
import type { Credential } from '../types'
import type { WorkflowLabels } from './AffectedWorkflowList'
import type { CreateCredential } from './CredentialCreateDialog'
import { loadConnectionDialogs } from './panel-loaders'
import { EmptyView, PanelChrome } from './panel-primitives'
import { Button } from './ui/Button'
import { SelectControl, TextInput } from './ui/Form'
import './ConnectionsPanel.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'

const CONNECTION_TAGS = [PLATFORM_TAG, 'credentials'] as const

const CONNECTION_ROW_HEIGHT = 48

const CredentialCreateDialog = lazy(() => loadConnectionDialogs().then((m) => ({ default: m.CredentialCreateDialog })))
const CredentialRevokeDialog = lazy(() => loadConnectionDialogs().then((m) => ({ default: m.CredentialRevokeDialog })))
const CredentialRotateModal = lazy(() => loadConnectionDialogs().then((m) => ({ default: m.CredentialRotateModal })))

type ConnectionDialog = { kind: 'create' } | { kind: 'rotate' | 'revoke'; name: string }

const HEALTH_TILES = [
  { key: 'expiring', tone: 'warning', label: 'rightPanel.credentials.health.expiring' },
  { key: 'errors', tone: 'danger', label: 'rightPanel.credentials.health.errors' },
  { key: 'unused', tone: 'neutral', label: 'rightPanel.credentials.health.unused' },
] as const

const HEALTH_PILLS = {
  healthy: { tone: 'healthy', label: 'vitals.severity.healthy' },
  warning: { tone: 'warn', label: 'recoveryDialog.evidence.kind.recent_error' },
  missing: { tone: 'unhealthy', label: 'rightPanel.credentials.status.missing' },
  unknown: { tone: 'neutral', label: 'common.unknown' },
} as const

function SpacerRow({ height, columns }: { height: number; columns: number }) {
  if (height <= 0) return null
  return <tr aria-hidden="true" style={{ height }}><td colSpan={columns} /></tr>
}

export function ConnectionsPanel({
  credentials,
  workflows,
  onCreateCredential,
  onRevokeCredential,
  canWrite,
}: {
  credentials: Credential[]
  workflows: WorkflowLabels
  onCreateCredential: CreateCredential
  onRevokeCredential: (name: string) => Promise<boolean>
  canWrite: boolean
}) {
  const { t } = useT()
  const platformVersion = useInvalidationNonce(CONNECTION_TAGS)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [dialog, setDialog] = useState<ConnectionDialog | null>(null)
  // The first open waits on a chunk with the panel still live; the first request wins, as under a backdrop.
  const openDialog = (next: ConnectionDialog) => setDialog((current) => current ?? next)
  const [healthByName, setHealthByName] = useState<Map<string, CredentialHealthSnapshot>>(new Map())
  const [managedStorageAvailable, setManagedStorageAvailable] = useState(true)
  const [healthUnavailable, setHealthUnavailable] = useState(false)
  const [expiryNowMs, setExpiryNowMs] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setExpiryNowMs(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false
    setHealthUnavailable(false)
    setHealthByName(new Map())
    setManagedStorageAvailable(true)
    api('/credentials/health')
      .then((response) => {
        if (cancelled) return
        const raw = (response ?? {}) as {
          credentials?: CredentialHealthSnapshot[]
          managedStorageAvailable?: boolean
        }
        const map = new Map<string, CredentialHealthSnapshot>()
        for (const entry of Array.isArray(raw.credentials) ? raw.credentials : []) {
          if (entry && typeof entry.name === 'string') map.set(entry.name, entry)
        }
        setHealthByName(map)
        setManagedStorageAvailable(raw.managedStorageAvailable === true)
      })
      .catch(() => {
        if (!cancelled) {
          setHealthUnavailable(true)
          setManagedStorageAvailable(false)
        }
    })
    return () => { cancelled = true }
  }, [credentials, platformVersion])

  const kinds = useMemo(() => listCredentialKinds(credentials), [credentials])
  const filteredCredentials = useMemo(
    () => filterCredentials(credentials, query, kind),
    [credentials, kind, query],
  )
  const {
    containerRef,
    visibleItems,
    totalHeight,
    startOffset,
  } = useVirtualList({
    items: filteredCredentials,
    rowHeight: CONNECTION_ROW_HEIGHT,
    resetScrollKey: `${query}\u0000${kind}`,
    getItemKey: (credential) => credential.id,
  })
  const healthSummary = useMemo(
    () => summarizeCredentialHealth(credentials, healthByName, expiryNowMs),
    [credentials, healthByName, expiryNowMs],
  )
  const columnCount = canWrite ? 8 : 7

  return (
    <PanelChrome
      title={t('rightPanel.credentials.title')}
      description={t('rightPanel.credentials.description')}
    >
      <section
        className="we-card we-connections-inventory"
        aria-label={t('rightPanel.credentials.title')}
      >
        <div className="we-card__header">
          <p className="helper-text">
            {t('rightPanel.credentials.inventoryCount', {
              shown: filteredCredentials.length,
              total: credentials.length,
            })}
          </p>
          {canWrite && (
            <Button variant="primary"
              type="button"

              onClick={() => openDialog({ kind: 'create' })}
            >
              <Plus size={14} aria-hidden="true" />
              <span>{t('rightPanel.credentials.addButton')}</span>
            </Button>
          )}
        </div>

        {healthByName.size > 0 && (
          <dl className="we-connections-health" data-testid="connections-health-summary">
            {HEALTH_TILES.map(({ key, tone, label }) => (
              <div
                key={key}
                className={`ui-status-summary ui-status-summary--${healthSummary[key] > 0 ? tone : 'neutral'}`}
                data-testid={`connections-health-${key}`}
              >
                <dt>{t(label)}</dt>
                <dd>{healthSummary[key]}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="we-list-toolbar">
          <label className="we-list-search">
            <Search size={15} aria-hidden="true" />
            <TextInput
              type="search"

              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('rightPanel.credentials.searchPlaceholder')}
              aria-label={t('rightPanel.credentials.searchPlaceholder')}
            />
          </label>
          <label className="we-connections-inventory__type-filter">
            <span className="we-sr-only">{t('rightPanel.credentials.typeFilter')}</span>
            <SelectControl

              value={kind}
              onChange={(event) => setKind(event.target.value)}
              aria-label={t('rightPanel.credentials.typeFilter')}
            >
              <option value="">{t('activity.filter.all')}</option>
              {kinds.map((option) => <option key={option} value={option}>{option}</option>)}
            </SelectControl>
          </label>
        </div>

        {healthUnavailable && (
          <p className="we-connections-inventory__notice" role="status">
            <AlertCircle size={14} aria-hidden="true" />
            {t('rightPanel.credentials.healthUnavailable')}
          </p>
        )}

        {credentials.length === 0 ? (
          <EmptyView
            icon={<KeyRound size={22} />}
            title={t('rightPanel.credentials.empty.title')}
            body={t('rightPanel.credentials.empty.body')}
            cta={canWrite ? {
              label: t('rightPanel.credentials.addButton'),
              onClick: () => openDialog({ kind: 'create' }),
            } : undefined}
            secondary={DOCS_URL ? { label: t('rightPanel.credentials.empty.learn'), href: DOCS_URL } : undefined}
          />
        ) : filteredCredentials.length === 0 ? (
          <EmptyView
            icon={<Search size={22} />}
            title={t('rightPanel.credentials.noMatches.title')}
            body={t('rightPanel.credentials.noMatches.body')}
            cta={{
              label: t('common.clearFilter'),
              onClick: () => {
                setQuery('')
                setKind('')
              },
            }}
          />
        ) : (
          <div
            ref={containerRef}
            className="we-virtual-list we-connections-inventory__list"
            data-testid="connections-virtual-list"
            tabIndex={0}
          >
            <table
              className="we-connections-table"
              aria-label={t('rightPanel.credentials.title')}
              aria-rowcount={filteredCredentials.length + 1}
              data-testid="connections-table"
            >
              <thead>
                <tr aria-rowindex={1}>
                  <th scope="col">{t('workflowsDashboard.columnName')}</th>
                  <th scope="col" data-column="type">{t('scim.col.type')}</th>
                  <th scope="col" data-column="health">{t('workflowsDashboard.columnHealth')}</th>
                  <th scope="col" data-column="usedBy" title={t('rightPanel.credentials.usedByScope')}>
                    {t('rightPanel.credentials.usedBy')}
                  </th>
                  <th scope="col" data-column="lastUsed">{t('rightPanel.credentials.lastUsed')}</th>
                  <th scope="col" data-column="expiry">{t('rightPanel.credentials.expiryColumn')}</th>
                  <th scope="col" data-column="owner">{t('recoveryItems.drawer.owner')}</th>
                  {canWrite && (
                    <th scope="col" data-column="actions">
                      <span className="we-sr-only">{t('workflowsDashboard.columnActions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                <SpacerRow height={startOffset} columns={columnCount} />
                {visibleItems.map(({ item: credential, index }) => {
                  const health = healthByName.get(credential.name)
                  const pill = HEALTH_PILLS[credentialHealthState(health)]
                  const expiry = expiryStatus(health?.expiresAt ?? credential.expiresAt, expiryNowMs)
                  const expiryLabel = expiry.kind === 'expired'
                    ? t('rightPanel.credentials.expiry.expired')
                    : expiry.kind === 'soon'
                      ? t('rightPanel.credentials.expiry.expiresInDays', { count: expiry.days })
                      : expiry.kind === 'ok'
                        ? new Date(health?.expiresAt ?? credential.expiresAt ?? '').toLocaleDateString(getResolvedLocale())
                        : t('common.none')
                  const lastUsedAt = health?.lastUsedAt ? new Date(health.lastUsedAt) : null
                  const references = knownWorkflowReferences(health)
                  return (
                    <tr key={credential.id} aria-rowindex={index + 2}>
                      <th scope="row" title={credential.name}>{credential.name}</th>
                      <td title={credential.kind}>{credential.kind}</td>
                      <td>
                        <span className={`we-secret-pill we-secret-pill--${pill.tone}`}>{t(pill.label)}</span>
                      </td>
                      <td
                        data-testid="connections-used-by"
                        title={references?.map((id) => workflows.find((workflow) => workflow.id === id)?.name ?? id).join(', ') || undefined}
                      >
                        {references
                          ? t('rightPanel.credentials.usedByCount', { count: references.length })
                          : '—'}
                      </td>
                      <td title={lastUsedAt?.toLocaleString(getResolvedLocale())}>
                        {lastUsedAt
                          ? lastUsedAt.toLocaleDateString(getResolvedLocale())
                          : health ? t('rightPanel.credentials.lastUsedNone') : '—'}
                      </td>
                      <td data-expiry={expiry.kind} title={expiryLabel}>{expiryLabel}</td>
                      <td title={credential.createdBy ?? undefined}>
                        {credential.createdBy || t('rightPanel.chrome.kicker')}
                      </td>
                      {canWrite && (
                        <td data-column="actions">
                          <div className="we-connections-table__actions">
                            <Button
                              size="sm"
                              data-testid="connections-rotate"
                              onClick={() => openDialog({ kind: 'rotate', name: credential.name })}
                            >
                              {t('credentialRotation.action.rotate')}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              data-testid="connections-revoke"
                              onClick={() => openDialog({ kind: 'revoke', name: credential.name })}
                            >
                              {t('rightPanel.credentials.revoke')}
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
                <SpacerRow
                  height={totalHeight - startOffset - visibleItems.length * CONNECTION_ROW_HEIGHT}
                  columns={columnCount}
                />
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog && canWrite && (
        <Suspense fallback={null}>
          {dialog.kind === 'create' && (
            <CredentialCreateDialog
              onClose={() => setDialog(null)}
              onCreate={onCreateCredential}
              managedStorageAvailable={managedStorageAvailable}
            />
          )}
          {dialog.kind === 'rotate' && (
            <CredentialRotateModal credentialName={dialog.name} workflows={workflows} onClose={() => setDialog(null)} />
          )}
          {dialog.kind === 'revoke' && (
            <CredentialRevokeDialog
              credentialName={dialog.name}
              workflows={workflows}
              onClose={() => setDialog(null)}
              onRevoke={onRevokeCredential}
            />
          )}
        </Suspense>
      )}
    </PanelChrome>
  )
}
