/**
 * Upstream health sources admin panel inside `OperationsPage` (Reliability
 * section). Lists each operator-declared status feed with its derived status,
 * supports create / edit / delete, and a per-source "Check now" button that
 * triggers an immediate poll on the server.
 *
 * The server's `permission: "upstream.write"` is the load-bearing gate; non-
 * admin operators see the form but writes return 403 (translated via
 * `tApiError`). The list read is `upstream.read` (viewer+).
 *
 * No new web deps — hand-written form + the shared `@janusly/shared/src/
 * upstream-health` enums (subpath import, not the barrel).
 */

import React, { useEffect, useState } from 'react'
import { Activity, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { EmptyState } from './EmptyState'
import {
  DEFAULT_CHECK_INTERVAL_SECONDS,
  MAX_CHECK_INTERVAL_SECONDS,
  MIN_CHECK_INTERVAL_SECONDS,
  UPSTREAM_HEALTH_KINDS,
  type UpstreamComponentStatus,
  type UpstreamHealthKind,
} from '@janusly/shared/src/upstream-health'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useConfirm } from './ConfirmDialog'

type UpstreamHealthSource = {
  id: string
  name: string
  kind: UpstreamHealthKind
  url: string
  expectedComponents: string[]
  checkIntervalSeconds: number
  enabled: boolean
  lastStatus: UpstreamComponentStatus | null
  lastDegraded: boolean
  lastCheckedAt: string | null
  lastErrorReason: string | null
}

type SourceForm = {
  name: string
  kind: UpstreamHealthKind
  url: string
  /** Comma-separated component names; split on submit. */
  expectedComponents: string
  checkIntervalSeconds: number
  enabled: boolean
}

const EMPTY_FORM: SourceForm = {
  name: '',
  kind: 'statuspage_io',
  url: '',
  expectedComponents: '',
  checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
  enabled: true,
}

function sourceToForm(s: UpstreamHealthSource): SourceForm {
  return {
    name: s.name,
    kind: s.kind,
    url: s.url,
    expectedComponents: s.expectedComponents.join(', '),
    checkIntervalSeconds: s.checkIntervalSeconds,
    enabled: s.enabled,
  }
}

/** Status → status-color token suffix (drives the `we-status-dot--*` class). */
function statusTint(s: UpstreamHealthSource): 'green' | 'amber' | 'red' | 'gray' {
  if (s.lastStatus === null) return 'gray'
  if (s.lastDegraded) return s.lastStatus === 'major_outage' ? 'red' : 'amber'
  return 'green'
}

export function UpstreamHealthPanel(): React.ReactElement {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)

  const [sources, setSources] = useState<UpstreamHealthSource[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api('/upstream/sources')
      .then((resp) => {
        if (cancelled) return
        setSources(((resp as { sources?: UpstreamHealthSource[] })?.sources) ?? [])
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion])

  function cancelForm(): void {
    setShowForm(false)
    setForm(EMPTY_FORM)
    setEditingId(null)
  }

  function startEdit(s: UpstreamHealthSource): void {
    setForm(sourceToForm(s))
    setEditingId(s.id)
    setShowForm(true)
  }

  async function submitSource(): Promise<void> {
    setSubmitting(true)
    try {
      const body = {
        source: {
          name: form.name.trim(),
          kind: form.kind,
          url: form.url.trim(),
          expectedComponents: form.expectedComponents
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0),
          checkIntervalSeconds: form.checkIntervalSeconds,
          enabled: form.enabled,
        },
      }
      if (editingId) {
        await api(`/upstream/sources/${editingId}`, { method: 'POST', body: JSON.stringify(body) })
        addToast(t('upstreamHealth.toast.updated') as string, 'success')
      } else {
        await api('/upstream/sources', { method: 'POST', body: JSON.stringify(body) })
        addToast(t('upstreamHealth.toast.created') as string, 'success')
      }
      cancelForm()
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('upstreamHealth.toast.error') as string), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteSource(s: UpstreamHealthSource): Promise<void> {
    if (!(await confirmDialog({ body: t('upstreamHealth.confirm.delete', { name: s.name }) as string, tone: 'danger' }))) return
    try {
      await api(`/upstream/sources/${s.id}`, { method: 'DELETE' })
      addToast(t('upstreamHealth.toast.deleted') as string, 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('upstreamHealth.toast.error') as string), 'error')
    }
  }

  async function checkNow(s: UpstreamHealthSource): Promise<void> {
    setCheckingId(s.id)
    try {
      await api(`/upstream/sources/${s.id}/check`, { method: 'POST', body: '{}' })
      addToast(t('upstreamHealth.toast.checked') as string, 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('upstreamHealth.toast.error') as string), 'error')
    } finally {
      setCheckingId(null)
    }
  }

  return (
    <section className="we-card we-upstream-health" aria-label={t('upstreamHealth.panel.title')}>
      <div className="we-card__header">
        <h3>
          <Activity size={16} aria-hidden /> {t('upstreamHealth.panel.title')}
        </h3>
        <button
          type="button"
          className="we-btn we-btn--ghost we-btn--sm"
          onClick={() => (showForm ? cancelForm() : setShowForm(true))}
        >
          <Plus size={14} aria-hidden /> {t('upstreamHealth.panel.new')}
        </button>
      </div>

      <p className="we-card__subtitle">{t('upstreamHealth.panel.subtitle')}</p>

      {showForm && (
        <div className="we-upstream-health__form" data-testid="upstream-source-form">
          <label>
            {t('upstreamHealth.form.name')}
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={80}
              placeholder={t('upstreamHealth.form.placeholder.name') as string}
            />
          </label>
          <label>
            {t('upstreamHealth.form.kind')}
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as UpstreamHealthKind })}
            >
              {UPSTREAM_HEALTH_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`upstreamHealth.kinds.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('upstreamHealth.form.url')}
            <input
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              maxLength={2048}
              placeholder={t('upstreamHealth.form.placeholder.url') as string}
            />
          </label>
          {(form.kind === 'statuspage_io' || form.kind === 'atlassian_statuspage') && (
            <label>
              {t('upstreamHealth.form.expectedComponents')}
              <input
                type="text"
                value={form.expectedComponents}
                onChange={(e) => setForm({ ...form, expectedComponents: e.target.value })}
                placeholder={t('upstreamHealth.form.placeholder.expectedComponents') as string}
              />
              <small className="we-field-hint">{t('upstreamHealth.form.hint.expectedComponents')}</small>
            </label>
          )}
          <label>
            {t('upstreamHealth.form.checkIntervalSeconds')}
            <input
              type="number"
              min={MIN_CHECK_INTERVAL_SECONDS}
              max={MAX_CHECK_INTERVAL_SECONDS}
              value={form.checkIntervalSeconds}
              onChange={(e) => setForm({ ...form, checkIntervalSeconds: Number(e.target.value) })}
            />
          </label>
          <label className="we-checkbox-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            {t('upstreamHealth.form.enabled')}
          </label>

          <div className="we-upstream-health__form-actions">
            <button
              type="button"
              className="we-btn we-btn--primary we-btn--sm"
              onClick={() => void submitSource()}
              disabled={submitting || form.name.trim().length === 0 || form.url.trim().length === 0}
            >
              {editingId ? t('upstreamHealth.form.saveChanges') : t('common.save')}
            </button>
            <button type="button" className="we-btn we-btn--ghost we-btn--sm" onClick={cancelForm}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="we-muted">{t('common.loading')}</p>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={<Activity size={20} aria-hidden />}
          kicker={t('upstreamHealth.empty.title') as string}
          body={t('upstreamHealth.empty.description') as string}
          testId="upstream-health-empty"
        />
      ) : (
        <ul className="we-list" aria-label={t('upstreamHealth.list.label')}>
          {sources.map((s) => (
            <li key={s.id} className="we-list-row">
              <div className="we-list-row__main">
                <span className={`we-status-dot we-status-dot--${statusTint(s)}`} aria-hidden />
                <span className="we-list-row__title">{s.name}</span>
                <span className="we-chip we-chip--muted">{t(`upstreamHealth.kinds.${s.kind}`)}</span>
                {s.lastStatus && (
                  <span className={`we-chip ${s.lastDegraded ? 'we-chip--danger' : 'we-chip--ok'}`}>
                    {t(`upstreamHealth.status.${s.lastStatus}`)}
                  </span>
                )}
                {!s.enabled && <span className="we-chip we-chip--muted">{t('upstreamHealth.disabled')}</span>}
              </div>
              <div className="we-list-row__meta">
                {s.lastCheckedAt ? (
                  <span className="we-muted">
                    {t('upstreamHealth.lastChecked', {
                      when: new Date(s.lastCheckedAt).toLocaleString(getResolvedLocale()),
                    })}
                  </span>
                ) : (
                  <span className="we-muted">{t('upstreamHealth.neverChecked')}</span>
                )}
                {s.lastErrorReason && (
                  <span className="we-chip we-chip--warn" title={t('upstreamHealth.failOpen') as string}>
                    {t(`upstreamHealth.errorReason.${s.lastErrorReason}`)}
                  </span>
                )}
              </div>
              <div className="we-list-row__actions">
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--icon"
                  title={t('upstreamHealth.action.checkNow') as string}
                  onClick={() => void checkNow(s)}
                  disabled={checkingId === s.id}
                >
                  <RefreshCw size={14} aria-hidden className={checkingId === s.id ? 'we-spin' : undefined} />
                </button>
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--icon"
                  title={t('common.edit') as string}
                  onClick={() => startEdit(s)}
                >
                  <Pencil size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--icon"
                  title={t('common.delete') as string}
                  onClick={() => void deleteSource(s)}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
