/**
 * Alert policies admin CRUD inside `OperationsPanel`. v1 surfaces the
 * core flows: list, create, toggle enabled, delete. The form swaps its
 * parameters sub-form based on the selected trigger and filters the
 * channel credential dropdown by destination kind so an operator can't
 * pick a `github_token` credential for a Slack channel.
 *
 * The server's `permission: "alerts.write"` is the load-bearing gate.
 * Non-admin operators see the form but writes return 403; the toast
 * envelope is translated via `tApiError`.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Bell, Pencil, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import {
  ALERT_COOLDOWN_SECONDS_DEFAULT,
  ALERT_TRIGGERS,
  type AlertDestination,
  type AlertTrigger,
} from '@janusly/shared/src/alert-policy'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { tApiError, useT } from '../i18n'

type Channel = {
  destination: AlertDestination
  credentialName: string
  params?: Record<string, unknown>
}

type AlertPolicy = {
  id: string
  name: string
  trigger: AlertTrigger
  parameters: Record<string, unknown>
  channels: Channel[]
  cooldownSeconds: number
  enabled: boolean
}

type Credential = {
  id: string
  name: string
  kind: string
}

const KIND_FOR_DESTINATION: Record<AlertDestination, string> = {
  slack: 'slack_webhook',
  webhook: 'webhook_secret',
  email: '',
  github: 'github_token',
}

const EMPTY_FORM: {
  name: string
  trigger: AlertTrigger
  errorSignaturePattern: string
  workflowIds: string
  minFrequency: number
  stalledMinutes: number
  scope: 'org' | 'workflow' | ''
  channels: Channel[]
  cooldownSeconds: number
  enabled: boolean
} = {
  name: '',
  trigger: 'dlq.entry_created',
  errorSignaturePattern: '',
  workflowIds: '',
  minFrequency: 3,
  stalledMinutes: 60,
  scope: '',
  channels: [{ destination: 'slack', credentialName: '', params: {} }],
  cooldownSeconds: ALERT_COOLDOWN_SECONDS_DEFAULT,
  enabled: true,
}

/**
 * Hydrate the flat form shape from a persisted `AlertPolicy`. The reverse
 * of `buildParameters` — used when the operator clicks Edit on a row so
 * every field renders pre-populated.
 */
function policyToForm(policy: AlertPolicy): typeof EMPTY_FORM {
  const params = (policy.parameters ?? {}) as Record<string, unknown>
  return {
    name: policy.name,
    trigger: policy.trigger,
    errorSignaturePattern:
      typeof params.errorSignaturePattern === 'string' ? params.errorSignaturePattern : '',
    workflowIds: Array.isArray(params.workflowIds) ? params.workflowIds.join(', ') : '',
    minFrequency: typeof params.minFrequency === 'number' ? params.minFrequency : 3,
    stalledMinutes: typeof params.stalledMinutes === 'number' ? params.stalledMinutes : 60,
    scope:
      params.scope === 'org' || params.scope === 'workflow' ? params.scope : '',
    channels: policy.channels.length > 0 ? policy.channels : EMPTY_FORM.channels,
    cooldownSeconds: policy.cooldownSeconds,
    enabled: policy.enabled,
  }
}

function buildParameters(form: typeof EMPTY_FORM): Record<string, unknown> {
  const workflowIds = form.workflowIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  switch (form.trigger) {
    case 'dlq.entry_created':
      return {
        ...(form.errorSignaturePattern ? { errorSignaturePattern: form.errorSignaturePattern } : {}),
        ...(workflowIds.length ? { workflowIds } : {}),
      }
    case 'failure_cluster.threshold':
      return { minFrequency: form.minFrequency }
    case 'budget.blocked':
      return {
        ...(form.scope ? { scope: form.scope } : {}),
        ...(workflowIds.length ? { workflowIds } : {}),
      }
    case 'limiter.degraded':
      return {}
    case 'workflow.slo_breach':
      return {
        ...(workflowIds.length ? { workflowIds } : {}),
      }
    case 'approval.stalled':
      return {
        stalledMinutes: form.stalledMinutes,
        ...(workflowIds.length ? { workflowIds } : {}),
      }
    default:
      return {}
  }
}

export function AlertPoliciesPanel(): React.ReactElement {
  const { t } = useT()
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)
  const orgId = useWorkflowStore((s) => s.orgId)

  const [policies, setPolicies] = useState<AlertPolicy[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function startEdit(policy: AlertPolicy): void {
    setForm(policyToForm(policy))
    setEditingId(policy.id)
    setShowForm(true)
  }

  function cancelForm(): void {
    setShowForm(false)
    setForm(EMPTY_FORM)
    setEditingId(null)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api('/alerts/policies').catch(() => ({ policies: [] })),
      api('/credentials').catch(() => []),
    ])
      .then(([policyResp, credResp]) => {
        if (cancelled) return
        setPolicies((policyResp?.policies as AlertPolicy[]) ?? [])
        setCredentials((credResp as Credential[]) ?? [])
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion])

  const availableCredentialsByDestination = useMemo(() => {
    const map: Record<AlertDestination, Credential[]> = { slack: [], webhook: [], email: [], github: [] }
    for (const cred of credentials) {
      for (const dest of ['slack', 'webhook', 'email', 'github'] as AlertDestination[]) {
        const wantedKind = KIND_FOR_DESTINATION[dest]
        if (!wantedKind || cred.kind === wantedKind) map[dest].push(cred)
      }
    }
    return map
  }, [credentials])

  const visibleAlertTriggers = useMemo(
    () => orgId === 'system'
      ? ALERT_TRIGGERS
      : ALERT_TRIGGERS.filter((trigger) => trigger !== 'limiter.degraded'),
    [orgId],
  )

  useEffect(() => {
    if (orgId === 'system' || form.trigger !== 'limiter.degraded') return
    setForm((current) => current.trigger === 'limiter.degraded'
      ? { ...current, trigger: 'dlq.entry_created' }
      : current)
  }, [form.trigger, orgId])

  async function submitPolicy(): Promise<void> {
    setSubmitting(true)
    try {
      const body = {
        name: form.name.trim(),
        trigger: form.trigger,
        parameters: buildParameters(form),
        channels: form.channels.filter((c) => c.credentialName.trim().length > 0),
        cooldownSeconds: form.cooldownSeconds,
        enabled: form.enabled,
      }
      if (editingId) {
        await api(`/alerts/policies/${editingId}`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        addToast(t('alerts.toast.updated') as string, 'success')
      } else {
        await api('/alerts/policies', { method: 'POST', body: JSON.stringify(body) })
        addToast(t('alerts.toast.created') as string, 'success')
      }
      setForm(EMPTY_FORM)
      setEditingId(null)
      setShowForm(false)
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error') as string), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleEnabled(policy: AlertPolicy): Promise<void> {
    try {
      await api(`/alerts/policies/${policy.id}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !policy.enabled }),
      })
      addToast(t('alerts.toast.updated') as string, 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error') as string), 'error')
    }
  }

  async function deletePolicy(policy: AlertPolicy): Promise<void> {
    if (!confirm(t('alerts.confirm.delete', { name: policy.name }))) return
    try {
      await api(`/alerts/policies/${policy.id}`, { method: 'DELETE' })
      addToast(t('alerts.toast.deleted') as string, 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error') as string), 'error')
    }
  }

  return (
    <section className="we-card we-alert-policies" aria-label={t('alerts.panel.title')}>
      <div className="we-card__header">
        <h3>
          <Bell size={16} aria-hidden /> {t('alerts.panel.title')}
        </h3>
        <button
          type="button"
          className="we-btn we-btn--ghost we-btn--sm"
          onClick={() => {
            if (showForm) cancelForm()
            else setShowForm(true)
          }}
        >
          <Plus size={14} aria-hidden /> {t('alerts.panel.new')}
        </button>
      </div>

      {showForm && (
        <div className="we-alert-policies__form" data-testid="alert-policy-form">
          <label>
            {t('alerts.form.name')}
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
            />
          </label>
          <label>
            {t('alerts.form.trigger')}
            <select
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value as AlertTrigger })}
            >
              {visibleAlertTriggers.map((trigger) => (
                <option key={trigger} value={trigger}>
                  {t(`alerts.triggers.${trigger}`)}
                </option>
              ))}
            </select>
          </label>

          {form.trigger === 'dlq.entry_created' && (
            <>
              <label>
                {t('alerts.form.errorSignaturePattern')}
                <input
                  type="text"
                  value={form.errorSignaturePattern}
                  onChange={(e) => setForm({ ...form, errorSignaturePattern: e.target.value })}
                  placeholder={t('alerts.form.placeholder.errorSignaturePattern') as string}
                  maxLength={200}
                />
              </label>
              <label>
                {t('alerts.form.workflowIds')}
                <input
                  type="text"
                  value={form.workflowIds}
                  onChange={(e) => setForm({ ...form, workflowIds: e.target.value })}
                  placeholder={t('alerts.form.placeholder.workflowIds') as string}
                />
              </label>
            </>
          )}
          {form.trigger === 'failure_cluster.threshold' && (
            <label>
              {t('alerts.form.minFrequency')}
              <input
                type="number"
                value={form.minFrequency}
                min={2}
                max={1000}
                onChange={(e) => setForm({ ...form, minFrequency: Number(e.target.value) || 2 })}
              />
            </label>
          )}
          {form.trigger === 'approval.stalled' && (
            <label>
              {t('alerts.form.stalledMinutes')}
              <input
                type="number"
                value={form.stalledMinutes}
                min={5}
                max={43200}
                onChange={(e) => setForm({ ...form, stalledMinutes: Number(e.target.value) || 60 })}
              />
            </label>
          )}
          {form.trigger === 'budget.blocked' && (
            <label>
              {t('alerts.form.scope')}
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as 'org' | 'workflow' | '' })}
              >
                <option value="">{t('alerts.form.scopeAny')}</option>
                <option value="org">{t('alerts.form.scopeOrg')}</option>
                <option value="workflow">{t('alerts.form.scopeWorkflow')}</option>
              </select>
            </label>
          )}

          <fieldset className="we-alert-policies__channels">
            <legend>{t('alerts.form.channels')}</legend>
            {form.channels.map((channel, idx) => {
              const dest = channel.destination
              const wantedKind = KIND_FOR_DESTINATION[dest]
              const available = wantedKind
                ? availableCredentialsByDestination[dest]
                : credentials
              const params = channel.params ?? {}
              return (
                <div key={idx} className="we-alert-policies__channel">
                  <select
                    aria-label={t('alerts.form.channelDestination')}
                    value={dest}
                    onChange={(e) => {
                      const newChannels = [...form.channels]
                      newChannels[idx] = {
                        destination: e.target.value as AlertDestination,
                        credentialName: '',
                        params: {},
                      }
                      setForm({ ...form, channels: newChannels })
                    }}
                  >
                    {(['slack', 'webhook', 'email', 'github'] as const).map((d) => (
                      <option key={d} value={d}>
                        {t(`alerts.destinations.${d}`)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('alerts.form.channelCredential')}
                    value={channel.credentialName}
                    onChange={(e) => {
                      const newChannels = [...form.channels]
                      newChannels[idx] = { ...channel, credentialName: e.target.value }
                      setForm({ ...form, channels: newChannels })
                    }}
                  >
                    <option value="">{t('alerts.form.pickCredential')}</option>
                    {available.map((cred) => (
                      <option key={cred.id} value={cred.name}>
                        {cred.name}
                      </option>
                    ))}
                  </select>
                  {dest === 'webhook' && (
                    <input
                      type="url"
                      placeholder={t('alerts.form.placeholder.webhookUrl') as string}
                      aria-label={t('alerts.form.webhookUrl')}
                      value={(params as { url?: string }).url ?? ''}
                      onChange={(e) => {
                        const newChannels = [...form.channels]
                        newChannels[idx] = {
                          ...channel,
                          params: { ...params, url: e.target.value },
                        }
                        setForm({ ...form, channels: newChannels })
                      }}
                    />
                  )}
                  {dest === 'email' && (
                    <input
                      type="email"
                      placeholder={t('alerts.form.placeholder.emailTo') as string}
                      aria-label={t('alerts.form.emailTo')}
                      value={(params as { to?: string }).to ?? ''}
                      onChange={(e) => {
                        const newChannels = [...form.channels]
                        newChannels[idx] = {
                          ...channel,
                          params: { ...params, to: e.target.value },
                        }
                        setForm({ ...form, channels: newChannels })
                      }}
                    />
                  )}
                  {dest === 'github' && (
                    <>
                      <input
                        type="text"
                        placeholder={t('alerts.form.placeholder.githubOwner') as string}
                        aria-label={t('alerts.form.githubOwner')}
                        value={(params as { owner?: string }).owner ?? ''}
                        onChange={(e) => {
                          const newChannels = [...form.channels]
                          newChannels[idx] = {
                            ...channel,
                            params: { ...params, owner: e.target.value },
                          }
                          setForm({ ...form, channels: newChannels })
                        }}
                      />
                      <input
                        type="text"
                        placeholder={t('alerts.form.placeholder.githubRepo') as string}
                        aria-label={t('alerts.form.githubRepo')}
                        value={(params as { repo?: string }).repo ?? ''}
                        onChange={(e) => {
                          const newChannels = [...form.channels]
                          newChannels[idx] = {
                            ...channel,
                            params: { ...params, repo: e.target.value },
                          }
                          setForm({ ...form, channels: newChannels })
                        }}
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="we-btn we-btn--ghost we-btn--sm"
                    onClick={() => {
                      const newChannels = form.channels.filter((_, i) => i !== idx)
                      setForm({
                        ...form,
                        channels: newChannels.length > 0 ? newChannels : EMPTY_FORM.channels,
                      })
                    }}
                  >
                    <Trash2 size={12} aria-hidden />
                  </button>
                </div>
              )
            })}
            {form.channels.length < 5 && (
              <button
                type="button"
                className="we-btn we-btn--ghost we-btn--sm"
                onClick={() =>
                  setForm({
                    ...form,
                    channels: [
                      ...form.channels,
                      { destination: 'slack', credentialName: '', params: {} },
                    ],
                  })
                }
              >
                + {t('alerts.form.addChannel')}
              </button>
            )}
          </fieldset>

          <label>
            {t('alerts.form.cooldownSeconds')}
            <input
              type="number"
              value={form.cooldownSeconds}
              min={60}
              max={86400}
              onChange={(e) => setForm({ ...form, cooldownSeconds: Number(e.target.value) || 900 })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />{' '}
            {t('alerts.form.enabled')}
          </label>

          <div className="we-alert-policies__form-actions">
            <button
              type="button"
              className="we-btn we-btn--primary we-btn--sm"
              onClick={submitPolicy}
              disabled={submitting || form.name.trim().length === 0}
            >
              {submitting
                ? t('alerts.form.submitting')
                : editingId
                ? t('alerts.form.saveChanges')
                : t('alerts.form.save')}
            </button>
            <button
              type="button"
              className="we-btn we-btn--ghost we-btn--sm"
              onClick={cancelForm}
            >
              {t('alerts.form.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="we-alert-policies__list" data-testid="alert-policies-list">
        {loading && <div className="we-list-row--empty">{t('common.loading')}</div>}
        {!loading && policies.length === 0 && (
          <div className="we-list-row--empty">{t('alerts.panel.empty')}</div>
        )}
        {!loading &&
          policies.map((policy) => (
            <div key={policy.id} className="we-list-row" data-testid="alert-policy-row">
              <div className="we-list-row__main">
                <strong>{policy.name}</strong>
                <span className="we-pill we-pill--neutral">
                  {t(`alerts.triggers.${policy.trigger}`)}
                </span>
                <span className="we-list-row__hint">
                  {t('alerts.row.cooldown', { seconds: policy.cooldownSeconds })} ·{' '}
                  {t('alerts.row.channels', { count: policy.channels.length })}
                </span>
              </div>
              <div className="we-list-row__actions">
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--sm"
                  onClick={() => startEdit(policy)}
                  aria-label={t('alerts.action.edit')}
                  data-testid="alert-policy-edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--sm"
                  onClick={() => toggleEnabled(policy)}
                  aria-label={
                    policy.enabled ? t('alerts.action.disable') : t('alerts.action.enable')
                  }
                >
                  {policy.enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                </button>
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--sm"
                  onClick={() => deletePolicy(policy)}
                  aria-label={t('alerts.action.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </section>
  )
}
