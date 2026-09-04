/**
 * Read-only operational shadow for workflows owned by another runtime.
 *
 * The UI exposes signed observer connections and projected lifecycle evidence,
 * but deliberately offers no retry, resume, cancel, or replay control.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Copy,
  Eye,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Button } from '@/components/ui/Button'
import { isRecord } from '../lib/guards'
import type { Credential as CredentialRecord } from '../types'

type ExternalRuntimeConnection = {
  id: string
  name: string
  runtimeKey: string
  signingCredentialName: string
  enabled: boolean
  callbackUrl: string
  createdAt: string
  updatedAt: string
}

type ExternalRun = {
  id: string
  connectionId: string
  externalWorkflowId: string
  externalRunId: string
  status: string
  lastObservedAt: string | null
}

type ExternalRecoveryCase = {
  id: string
  connectionId: string
  subjectKind: 'run' | 'step'
  externalWorkflowId: string
  externalRunId: string
  externalStepId: string | null
  state: 'detected' | 'observed_recovered'
  evidenceJson: unknown
  firstDetectedAt: string
  lastObservedAt: string
  observedRecoveredAt: string | null
}

type ExternalRuntimeShadow = {
  observerOnly: true
  connections: ExternalRuntimeConnection[]
  runs: ExternalRun[]
  cases: ExternalRecoveryCase[]
}

type Credential = Pick<CredentialRecord, 'id' | 'name' | 'kind'>

type ConnectionForm = {
  name: string
  runtimeKey: string
  signingCredentialName: string
  enabled: boolean
}

const emptyForm = (): ConnectionForm => ({
  name: '',
  runtimeKey: '',
  signingCredentialName: '',
  enabled: true,
})

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseConnections(value: unknown): ExternalRuntimeConnection[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is ExternalRuntimeConnection => isRecord(row)
    && typeof row.id === 'string'
    && typeof row.name === 'string'
    && typeof row.runtimeKey === 'string'
    && typeof row.signingCredentialName === 'string'
    && typeof row.enabled === 'boolean'
    && typeof row.callbackUrl === 'string'
    && typeof row.createdAt === 'string'
    && typeof row.updatedAt === 'string')
}

function parseRuns(value: unknown): ExternalRun[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is ExternalRun => isRecord(row)
    && typeof row.id === 'string'
    && typeof row.connectionId === 'string'
    && typeof row.externalWorkflowId === 'string'
    && typeof row.externalRunId === 'string'
    && typeof row.status === 'string'
    && isStringOrNull(row.lastObservedAt))
}

function parseCases(value: unknown): ExternalRecoveryCase[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is ExternalRecoveryCase => isRecord(row)
    && typeof row.id === 'string'
    && typeof row.connectionId === 'string'
    && (row.subjectKind === 'run' || row.subjectKind === 'step')
    && typeof row.externalWorkflowId === 'string'
    && typeof row.externalRunId === 'string'
    && isStringOrNull(row.externalStepId)
    && (row.state === 'detected' || row.state === 'observed_recovered')
    && typeof row.firstDetectedAt === 'string'
    && typeof row.lastObservedAt === 'string'
    && isStringOrNull(row.observedRecoveredAt))
}

function parseShadow(value: unknown): ExternalRuntimeShadow {
  if (!isRecord(value) || value.observerOnly !== true) {
    return { observerOnly: true, connections: [], runs: [], cases: [] }
  }
  return {
    observerOnly: true,
    connections: parseConnections(value.connections),
    runs: parseRuns(value.runs),
    cases: parseCases(value.cases),
  }
}

function parseCredentials(value: unknown): Credential[] {
  if (!Array.isArray(value)) return []
  return value.filter((credential): credential is Credential => isRecord(credential)
    && typeof credential.id === 'string'
    && typeof credential.name === 'string'
    && credential.kind === 'external_runtime_signing_secret')
}

function evidenceCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function ExternalRuntimePanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [shadow, setShadow] = useState<ExternalRuntimeShadow>(() => parseShadow(null))
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [form, setForm] = useState<ConnectionForm>(() => emptyForm())
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api('/integrations/external-runtimes'),
      canWrite ? api('/credentials').catch(() => []) : Promise.resolve([]),
    ])
      .then(([shadowResponse, credentialResponse]) => {
        if (cancelled) return
        setShadow(parseShadow(shadowResponse))
        setCredentials(parseCredentials(credentialResponse))
      })
      .catch((loadError) => {
        if (!cancelled) setError(tApiError(loadError) || t('externalRuntime.error.load'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [canWrite, platformVersion, t])

  const connectionNames = useMemo(
    () => new Map(shadow.connections.map((connection) => [connection.id, connection.name])),
    [shadow.connections],
  )
  const activeCases = shadow.cases.filter((item) => item.state === 'detected').length
  const recoveredCases = shadow.cases.length - activeCases
  const canSave = form.name.trim().length > 0
    && /^[a-z0-9][a-z0-9._-]*$/.test(form.runtimeKey.trim())
    && form.signingCredentialName.length > 0
    && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      await api('/integrations/external-runtimes', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          runtimeKey: form.runtimeKey.trim(),
          signingCredentialName: form.signingCredentialName,
          enabled: form.enabled,
        }),
      })
      addToast(t('externalRuntime.toast.created'), 'success')
      setForm(emptyForm())
      setShowForm(false)
      bumpPlatformVersion()
    } catch (saveError) {
      addToast(tApiError(saveError) || t('externalRuntime.error.save'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function remove(connection: ExternalRuntimeConnection) {
    if (!(await confirmDialog({
      body: t('externalRuntime.confirm.delete', { name: connection.name }),
      tone: 'danger',
    }))) return
    try {
      await api(`/integrations/external-runtimes/${encodeURIComponent(connection.id)}`, {
        method: 'DELETE',
      })
      addToast(t('externalRuntime.toast.deleted'), 'success')
      bumpPlatformVersion()
    } catch (deleteError) {
      addToast(tApiError(deleteError) || t('externalRuntime.error.delete'), 'error')
    }
  }

  async function copyCallback(connection: ExternalRuntimeConnection) {
    try {
      await navigator.clipboard.writeText(connection.callbackUrl)
      addToast(t('externalRuntime.toast.copied'), 'success')
    } catch {
      addToast(t('externalRuntime.error.copy'), 'error')
    }
  }

  return (
    <section className="we-card we-external-runtime" aria-labelledby="external-runtime-heading">
      <div className="we-card__header">
        <div>
          <div className="section-kicker">{t('externalRuntime.kicker')}</div>
          <h3 id="external-runtime-heading">
            <Eye size={16} aria-hidden /> {t('externalRuntime.title')}
          </h3>
        </div>
        {canWrite && (
          <Button variant="ghost" size="sm"
            type="button"

            onClick={() => {
              setShowForm((current) => !current)
              setForm(emptyForm())
            }}
          >
            {showForm ? <X size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
            {t(showForm ? 'externalRuntime.action.cancel' : 'externalRuntime.action.new')}
          </Button>
        )}
      </div>

      <div className="we-external-runtime__boundary" role="note">
        <Eye size={15} aria-hidden />
        <div>
          <strong>{t('externalRuntime.boundary.title')}</strong>
          <span>{t('externalRuntime.boundary.body')}</span>
        </div>
      </div>

      {showForm && (
        <div className="we-external-runtime__form" data-testid="external-runtime-form">
          <label>
            {t('externalRuntime.form.name')}
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              maxLength={120}
            />
          </label>
          <label>
            {t('externalRuntime.form.runtimeKey')}
            <input
              value={form.runtimeKey}
              onChange={(event) => setForm({ ...form, runtimeKey: event.target.value.toLowerCase() })}
              placeholder="temporal-prod"
              maxLength={120}
              autoComplete="off"
            />
          </label>
          <label>
            {t('externalRuntime.form.credential')}
            <select
              value={form.signingCredentialName}
              onChange={(event) => setForm({ ...form, signingCredentialName: event.target.value })}
            >
              <option value="">{t('externalRuntime.form.pickCredential')}</option>
              {credentials.map((credential) => (
                <option value={credential.name} key={credential.id}>{credential.name}</option>
              ))}
            </select>
            {credentials.length === 0 && (
              <span className="we-list-row__hint">{t('externalRuntime.form.noCredentials')}</span>
            )}
          </label>
          <label className="we-external-runtime__enabled">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            {t('externalRuntime.form.enabled')}
          </label>
          <Button variant="primary" size="sm"
            type="button"

            disabled={!canSave}
            onClick={() => void save()}
          >
            <Save size={14} aria-hidden />
            {t(saving ? 'externalRuntime.action.saving' : 'externalRuntime.action.create')}
          </Button>
        </div>
      )}

      {loading && <LoadingSkeleton rows={3} />}
      {!loading && error && <p className="error-text" role="alert">{error}</p>}
      {!loading && !error && (
        <>
          <div className="we-external-runtime__stats" aria-label={t('externalRuntime.stats.aria')}>
            <div>
              <span>{t('externalRuntime.stats.connections')}</span>
              <strong>{shadow.connections.length}</strong>
            </div>
            <div data-tone={activeCases > 0 ? 'danger' : 'neutral'}>
              <span>{t('externalRuntime.stats.detected')}</span>
              <strong>{activeCases}</strong>
            </div>
            <div data-tone="success">
              <span>{t('externalRuntime.stats.recovered')}</span>
              <strong>{recoveredCases}</strong>
            </div>
          </div>

          {shadow.connections.length === 0 ? (
            <EmptyState
              icon={<Activity size={18} aria-hidden />}
              kicker={t('externalRuntime.empty.kicker')}
              body={t('externalRuntime.empty.body')}
              testId="external-runtime-empty"
            />
          ) : (
            <ul className="we-external-runtime__connections" aria-label={t('externalRuntime.connections.aria')}>
              {shadow.connections.map((connection) => (
                <li className="we-list-row" key={connection.id} data-testid={`external-runtime-${connection.id}`}>
                  <div className="we-list-row__main">
                    <div className="we-list-row__title">
                      <strong>{connection.name}</strong>
                      <span className="we-pill" data-tone={connection.enabled ? 'success' : 'neutral'}>
                        {t(connection.enabled
                          ? 'externalRuntime.status.enabled'
                          : 'externalRuntime.status.disabled')}
                      </span>
                    </div>
                    <span className="we-list-row__hint">
                      {connection.runtimeKey} · {connection.signingCredentialName}
                    </span>
                    <code className="we-external-runtime__callback">{connection.callbackUrl}</code>
                  </div>
                  <div className="we-list-row__actions">
                    <Button variant="ghost" size="sm"
                      type="button"

                      onClick={() => void copyCallback(connection)}
                    >
                      <Copy size={13} aria-hidden /> {t('externalRuntime.action.copy')}
                    </Button>
                    {canWrite && (
                      <Button variant="danger" size="sm"
                        type="button"

                        onClick={() => void remove(connection)}
                      >
                        <Trash2 size={13} aria-hidden /> {t('externalRuntime.action.delete')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {shadow.cases.length > 0 && (
            <div className="we-external-runtime__cases">
              <div className="we-external-runtime__subhead">
                <div>
                  <h4>{t('externalRuntime.cases.title')}</h4>
                  <p>{t('externalRuntime.cases.helper')}</p>
                </div>
                <span className="we-pill" data-tone="neutral">{shadow.runs.length} {t('externalRuntime.cases.runs')}</span>
              </div>
              <ul aria-label={t('externalRuntime.cases.aria')}>
                {shadow.cases.map((item) => (
                  <li key={item.id} data-testid={`external-runtime-case-${item.id}`}>
                    <span
                      className="we-external-runtime__case-icon"
                      data-tone={item.state === 'detected' ? 'danger' : 'success'}
                    >
                      {item.state === 'detected'
                        ? <Activity size={15} aria-hidden />
                        : <CheckCircle2 size={15} aria-hidden />}
                    </span>
                    <div>
                      <strong>{item.externalStepId ?? item.externalRunId}</strong>
                      <span>
                        {connectionNames.get(item.connectionId) ?? t('externalRuntime.cases.deletedSource')}
                        {' · '}{item.externalWorkflowId}
                      </span>
                    </div>
                    <div className="we-external-runtime__case-meta">
                      <span className="we-pill" data-tone={item.state === 'detected' ? 'danger' : 'success'}>
                        {t(item.state === 'detected'
                          ? 'externalRuntime.case.detected'
                          : 'externalRuntime.case.observedRecovered')}
                      </span>
                      <span>{t('externalRuntime.case.evidence', { count: evidenceCount(item.evidenceJson) })}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
