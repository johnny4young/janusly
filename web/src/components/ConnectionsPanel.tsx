import {
  AlertCircle,
  KeyRound,
  LockKeyhole,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api'
import {
  credentialHealthState,
  filterCredentials,
  listCredentialKinds,
  type CredentialHealthSnapshot,
} from '../connections-inventory'
import { expiryStatus } from '../credential-expiry'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useVirtualList } from '../hooks/useVirtualList'
import { getResolvedLocale, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import type { Credential } from '../types'
import { CredentialRotateModal } from './CredentialRotateModal'
import { EmptyView, PanelChrome } from './panel-primitives'

const CREDENTIAL_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/
const CONNECTION_ROW_HEIGHT = 166

const CREDENTIAL_KINDS = [
  'generic',
  'github_token',
  'slack_webhook',
  'slack_signing_secret',
  'webhook_secret',
  'postgres',
  'pagerduty_api_token',
  'pagerduty_webhook_secret',
] as const

type CreateCredential = (credential: {
  name: string
  kind: string
  secretValue?: string
  secretRef?: string
  expiresAt?: string
}) => Promise<boolean>

function CredentialCreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: CreateCredential
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('generic')
  const [storage, setStorage] = useState<'managed' | 'environment'>('managed')
  const [secretValue, setSecretValue] = useState('')
  const [secretRef, setSecretRef] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  useDialogFocusTrap(dialogRef, { initialFocus: nameRef })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, submitting])

  const trimmedRef = secretRef.trim()
  const refInvalid = trimmedRef.length > 0 && !CREDENTIAL_ENV_VAR_NAME.test(trimmedRef)
  const canSubmit = name.trim().length > 0
    && (storage === 'managed' ? secretValue.length > 0 : CREDENTIAL_ENV_VAR_NAME.test(trimmedRef))

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const created = await onCreate({
        name: name.trim(),
        kind,
        ...(storage === 'managed' ? { secretValue } : { secretRef: trimmedRef }),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      })
      if (created) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="run-input-backdrop" onClick={() => { if (!submitting) onClose() }}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-create-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><LockKeyhole size={18} /></span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('rightPanel.credentials.formKicker')}</div>
            <h2 id="credential-create-title">{t('rightPanel.credentials.formTitle')}</h2>
            <p className="helper-text">{t('rightPanel.credentials.valuePlaceholder')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('common.close')}
            disabled={submitting}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="run-input-dialog__body">
            <fieldset className="we-fieldset" disabled={submitting}>
              <label>
                <span className="field-label">{t('rightPanel.credentials.nameLabel')}</span>
                <input
                  ref={nameRef}
                  className="text-field"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="field-label">{t('rightPanel.credentials.kindLabel')}</span>
                <select className="text-field" value={kind} onChange={(event) => setKind(event.target.value)}>
                  {CREDENTIAL_KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label>
                <span className="field-label">{t('rightPanel.credentials.storageLabel')}</span>
                <select
                  className="text-field"
                  value={storage}
                  onChange={(event) => setStorage(event.target.value as 'managed' | 'environment')}
                >
                  <option value="managed">{t('rightPanel.credentials.storage.managed')}</option>
                  <option value="environment">{t('rightPanel.credentials.storage.environment')}</option>
                </select>
              </label>
              <label>
                <span className="field-label">
                  {storage === 'managed'
                    ? t('rightPanel.credentials.valueLabel')
                    : t('rightPanel.credentials.envLabel')}
                </span>
                {storage === 'managed' ? (
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="text-field"
                    aria-label={t('rightPanel.credentials.valueLabel')}
                    value={secretValue}
                    onChange={(event) => setSecretValue(event.target.value)}
                    placeholder={t('rightPanel.credentials.valuePlaceholder')}
                  />
                ) : (
                  <input
                    className={`text-field${refInvalid ? ' text-field--error' : ''}`}
                    aria-label={t('rightPanel.credentials.envLabel')}
                    value={secretRef}
                    onChange={(event) => setSecretRef(event.target.value)}
                    placeholder={t('rightPanel.credentials.envPlaceholder')}
                    aria-invalid={refInvalid}
                    aria-describedby={refInvalid ? 'credential-secret-error' : undefined}
                  />
                )}
                {storage === 'managed' && (
                  <span className="helper-text">
                    {t('credentialRotation.field.newSecretValueHelp')}
                  </span>
                )}
                {storage === 'environment' && refInvalid && (
                  <span id="credential-secret-error" className="helper-text helper-text--error" role="alert">
                    <AlertCircle size={13} aria-hidden="true" /> {t('rightPanel.credentials.envInvalid')}
                  </span>
                )}
              </label>
              <label>
                <span className="field-label">{t('rightPanel.credentials.expiryLabel')}</span>
                <input
                  type="date"
                  className="text-field"
                  aria-label={t('rightPanel.credentials.expiryLabel')}
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
                <span className="helper-text">{t('rightPanel.credentials.expiryHint')}</span>
              </label>
            </fieldset>
          </div>

          <footer className="run-input-dialog__footer">
            <button type="button" className="command-button" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="command-button command-button-primary" disabled={!canSubmit || submitting}>
              <Plus size={14} aria-hidden="true" />
              <span>{submitting ? t('common.working') : t('rightPanel.credentials.addButton')}</span>
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

export function ConnectionsPanel({
  credentials,
  onCreateCredential,
  canWrite,
}: {
  credentials: Credential[]
  onCreateCredential: CreateCredential
  canWrite: boolean
}) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [creating, setCreating] = useState(false)
  const [rotating, setRotating] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [healthByName, setHealthByName] = useState<Map<string, CredentialHealthSnapshot>>(new Map())
  const [healthUnavailable, setHealthUnavailable] = useState(false)
  const [expiryNowMs, setExpiryNowMs] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setExpiryNowMs(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (credentials.length === 0) return
    let cancelled = false
    setHealthUnavailable(false)
    setHealthByName(new Map())
    api('/credentials/health')
      .then((response) => {
        if (cancelled) return
        const raw = (response ?? {}) as { credentials?: CredentialHealthSnapshot[] }
        const map = new Map<string, CredentialHealthSnapshot>()
        for (const entry of Array.isArray(raw.credentials) ? raw.credentials : []) {
          if (entry && typeof entry.name === 'string') map.set(entry.name, entry)
        }
        setHealthByName(map)
      })
      .catch(() => {
        if (!cancelled) setHealthUnavailable(true)
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

  const revoke = async (credential: Credential) => {
    if (!window.confirm(t('rightPanel.credentials.revokeConfirm', { name: credential.name }))) return
    setRevoking(credential.name)
    try {
      await api(`/credentials/${encodeURIComponent(credential.name)}`, { method: 'DELETE' })
      bumpPlatformVersion()
      addToast(t('rightPanel.credentials.revokeDone', { name: credential.name }), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('rightPanel.credentials.revokeFailed'), 'error')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <PanelChrome
      title={t('rightPanel.credentials.title')}
      description={t('rightPanel.credentials.description')}
      icon={<KeyRound size={18} />}
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
            <button
              type="button"
              className="command-button command-button-primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={14} aria-hidden="true" />
              <span>{t('rightPanel.credentials.addButton')}</span>
            </button>
          )}
        </div>

        <div className="we-list-toolbar">
          <label className="we-list-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              className="text-field"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('rightPanel.credentials.searchPlaceholder')}
              aria-label={t('rightPanel.credentials.searchPlaceholder')}
            />
          </label>
          <label className="we-connections-inventory__type-filter">
            <span className="we-sr-only">{t('rightPanel.credentials.typeFilter')}</span>
            <select
              className="text-field text-field--compact"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              aria-label={t('rightPanel.credentials.typeFilter')}
            >
              <option value="">{t('activity.filter.all')}</option>
              {kinds.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>

        {credentials.length > 0 && healthUnavailable && (
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
              onClick: () => setCreating(true),
            } : undefined}
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
            role="list"
            aria-label={t('rightPanel.credentials.title')}
            data-testid="connections-virtual-list"
          >
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div style={{ transform: `translateY(${startOffset}px)` }}>
                {visibleItems.map(({ item: credential, index }) => {
                  const health = healthByName.get(credential.name)
                  const healthState = credentialHealthState(health)
                  const healthTone = healthState === 'healthy'
                    ? 'healthy'
                    : healthState === 'warning'
                      ? 'warn'
                      : healthState === 'missing'
                        ? 'unhealthy'
                        : 'neutral'
                  const expiry = expiryStatus(health?.expiresAt ?? credential.expiresAt, expiryNowMs)
                  const expiryLabel = expiry.kind === 'expired'
                    ? t('rightPanel.credentials.expiry.expired')
                    : expiry.kind === 'soon'
                      ? t('rightPanel.credentials.expiry.expiresInDays', { count: expiry.days })
                      : expiry.kind === 'ok'
                        ? new Date(health?.expiresAt ?? credential.expiresAt ?? '').toLocaleDateString(getResolvedLocale())
                        : t('common.none')
                  const lastUsed = health?.lastUsedAt
                    ? new Date(health.lastUsedAt).toLocaleString(getResolvedLocale())
                    : t('recoveryDialog.playbook.never')
                  const healthLabelKey = healthState === 'healthy'
                    ? 'vitals.severity.healthy'
                    : healthState === 'warning'
                      ? 'recoveryDialog.evidence.kind.recent_error'
                      : healthState === 'missing'
                        ? 'rightPanel.credentials.status.missing'
                        : 'common.unknown'
                  return (
                    <div
                      key={credential.id}
                      className="we-connections-inventory__row-slot"
                      role="listitem"
                      aria-posinset={index + 1}
                      aria-setsize={filteredCredentials.length}
                    >
                      <article className="list-card we-connection-row">
                        <div className="we-connection-row__identity">
                          <strong title={credential.name}>{credential.name}</strong>
                          <span className={`we-secret-pill we-secret-pill--${healthTone}`}>
                            {t(healthLabelKey)}
                          </span>
                        </div>
                        <dl className="we-connection-row__facts">
                          <div>
                            <dt>{t('rightPanel.credentials.kindLabel')}</dt>
                            <dd>{credential.kind}</dd>
                          </div>
                          <div>
                            <dt>{t('dlq.owner.label')}</dt>
                            <dd title={credential.createdBy ?? undefined}>
                              {credential.createdBy || t('rightPanel.chrome.kicker')}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('rightPanel.credentials.expiryColumn')}</dt>
                            <dd data-expiry={expiry.kind}>{expiryLabel}</dd>
                          </div>
                          <div>
                            <dt>{t('rightPanel.credentials.lastUsed')}</dt>
                            <dd>{lastUsed}</dd>
                          </div>
                        </dl>
                        {canWrite && (
                          <div className="we-connection-row__actions">
                            <button
                              type="button"
                              className="small-command"
                              onClick={() => setRotating(credential.name)}
                              disabled={revoking !== null}
                            >
                              {t('credentialRotation.action.rotate')}
                            </button>
                            <button
                              type="button"
                              className="small-command danger"
                              onClick={() => { void revoke(credential) }}
                              disabled={revoking !== null}
                            >
                              {revoking === credential.name
                                ? t('common.working')
                                : t('rightPanel.credentials.revoke')}
                            </button>
                          </div>
                        )}
                      </article>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      {creating && canWrite && (
        <CredentialCreateDialog
          onClose={() => setCreating(false)}
          onCreate={onCreateCredential}
        />
      )}
      {rotating && canWrite && (
        <CredentialRotateModal credentialName={rotating} onClose={() => setRotating(null)} />
      )}
    </PanelChrome>
  )
}
