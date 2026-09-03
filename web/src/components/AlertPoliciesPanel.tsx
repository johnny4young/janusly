/**
 * Alert policies admin CRUD inside `OperationsPage`. v1 surfaces the
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
import { LoadingSkeleton } from './LoadingSkeleton'
import { AlertCircle, Bell, BellOff, Pencil, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { EmptyState } from './EmptyState'
import {
  ALERT_COOLDOWN_SECONDS_DEFAULT,
  ALERT_TRIGGERS,
  type AlertDestination,
  type AlertTrigger,
} from '@/lib/alert-policy'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { tApiError, useT } from '../i18n'
import { useConfirm } from './ConfirmDialog'
import { Button } from '@/components/ui/Button'

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

type SlackInteractionConnection = {
  id: string
  name: string
  enabled: boolean
}

/**
 * Form-only channel: the persisted `Channel` plus a stable client key. A list
 * keyed by array index corrupts controlled-input state when a middle row is
 * removed (the indices shift, so React reuses the wrong row's inputs); `_key`
 * stays attached to its row so removal reconciles correctly. Stripped before save.
 */
type FormChannel = Channel & { _key: string }
const newChannelKey = (): string => crypto.randomUUID()

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
  warnDays: number
  credentialKinds: string
  credentialNames: string
  scope: 'org' | 'workflow' | ''
  channels: FormChannel[]
  cooldownSeconds: number
  enabled: boolean
} = {
  name: '',
  trigger: 'dlq.entry_created',
  errorSignaturePattern: '',
  workflowIds: '',
  minFrequency: 3,
  stalledMinutes: 60,
  warnDays: 14,
  credentialKinds: '',
  credentialNames: '',
  scope: '',
  channels: [{ destination: 'slack', credentialName: '', params: {}, _key: newChannelKey() }],
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
    warnDays: typeof params.warnDays === 'number' ? params.warnDays : 14,
    credentialKinds: Array.isArray(params.credentialKinds) ? params.credentialKinds.join(', ') : '',
    credentialNames: Array.isArray(params.credentialNames) ? params.credentialNames.join(', ') : '',
    scope:
      params.scope === 'org' || params.scope === 'workflow' ? params.scope : '',
    channels:
      policy.channels.length > 0
        ? policy.channels.map((c) => ({ ...c, _key: newChannelKey() }))
        : EMPTY_FORM.channels,
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
    case 'workflow.schedule_anomaly':
      return {
        ...(workflowIds.length ? { workflowIds } : {}),
      }
    case 'credential.expiring': {
      const credentialKinds = form.credentialKinds.split(',').map((s) => s.trim()).filter(Boolean)
      const credentialNames = form.credentialNames.split(',').map((s) => s.trim()).filter(Boolean)
      return {
        warnDays: form.warnDays,
        ...(credentialKinds.length ? { credentialKinds } : {}),
        ...(credentialNames.length ? { credentialNames } : {}),
      }
    }
    default:
      return {}
  }
}

export function AlertPoliciesPanel({ canWrite = true }: { canWrite?: boolean } = {}): React.ReactElement {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const addToast = useWorkflowStore((s) => s.addToast)
  const orgId = useWorkflowStore((s) => s.orgId)

  const [policies, setPolicies] = useState<AlertPolicy[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [slackInteractions, setSlackInteractions] = useState<SlackInteractionConnection[]>([])
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
      api('/integrations/slack/interactions').catch(() => ({ connections: [] })),
    ])
      .then(([policyResp, credResp, slackResp]) => {
        if (cancelled) return
        const policyEnvelope = policyResp && typeof policyResp === 'object' && !Array.isArray(policyResp)
          ? policyResp as Record<string, unknown>
          : undefined
        setPolicies(Array.isArray(policyEnvelope?.policies) ? policyEnvelope.policies as AlertPolicy[] : [])
        setCredentials(Array.isArray(credResp) ? credResp as Credential[] : [])
        const slackEnvelope = slackResp && typeof slackResp === 'object' && !Array.isArray(slackResp)
          ? slackResp as { connections?: unknown }
          : undefined
        setSlackInteractions(Array.isArray(slackEnvelope?.connections)
          ? (slackEnvelope.connections as SlackInteractionConnection[]).filter((connection) =>
              typeof connection?.id === 'string'
              && typeof connection.name === 'string'
              && typeof connection.enabled === 'boolean')
          : [])
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
        channels: form.channels
          .filter((c) => c.credentialName.trim().length > 0)
          .map(({ _key, ...rest }) => rest),
        cooldownSeconds: form.cooldownSeconds,
        enabled: form.enabled,
      }
      if (editingId) {
        await api(`/alerts/policies/${editingId}`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        addToast(t('alerts.toast.updated'), 'success')
      } else {
        await api('/alerts/policies', { method: 'POST', body: JSON.stringify(body) })
        addToast(t('alerts.toast.created'), 'success')
      }
      setForm(EMPTY_FORM)
      setEditingId(null)
      setShowForm(false)
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error')), 'error')
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
      addToast(t('alerts.toast.updated'), 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error')), 'error')
    }
  }

  async function deletePolicy(policy: AlertPolicy): Promise<void> {
    if (!(await confirmDialog({ body: t('alerts.confirm.delete', { name: policy.name }), tone: 'danger' }))) return
    try {
      await api(`/alerts/policies/${policy.id}`, { method: 'DELETE' })
      addToast(t('alerts.toast.deleted'), 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('alerts.toast.error')), 'error')
    }
  }

  // Range validation for the per-trigger numeric fields. Each flag only fires
  // for the field its trigger actually shows, so an out-of-range value left over
  // from another trigger can't block the submit. cooldown is always shown.
  const minFrequencyInvalid =
    form.trigger === 'failure_cluster.threshold' && (form.minFrequency < 2 || form.minFrequency > 1000)
  const stalledMinutesInvalid =
    form.trigger === 'approval.stalled' && (form.stalledMinutes < 5 || form.stalledMinutes > 43200)
  const warnDaysInvalid =
    form.trigger === 'credential.expiring' && (form.warnDays < 1 || form.warnDays > 365)
  const cooldownInvalid = form.cooldownSeconds < 60 || form.cooldownSeconds > 86400

  return (
    <section className="we-card we-alert-policies" aria-label={t('alerts.panel.title')}>
      <div className="we-card__header">
        <h3>
          <Bell size={16} aria-hidden /> {t('alerts.panel.title')}
        </h3>
        <Button variant="ghost" size="sm"
          type="button"

          disabled={!canWrite}
          onClick={() => {
            if (showForm) cancelForm()
            else setShowForm(true)
          }}
        >
          <Plus size={14} aria-hidden /> {t('alerts.panel.new')}
        </Button>
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
                  placeholder={t('alerts.form.placeholder.errorSignaturePattern')}
                  maxLength={200}
                />
              </label>
              <label>
                {t('alerts.form.workflowIds')}
                <input
                  type="text"
                  value={form.workflowIds}
                  onChange={(e) => setForm({ ...form, workflowIds: e.target.value })}
                  placeholder={t('alerts.form.placeholder.workflowIds')}
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
                aria-invalid={minFrequencyInvalid}
                aria-describedby={minFrequencyInvalid ? 'alert-min-frequency-error' : undefined}
              />
              {minFrequencyInvalid && (
                <span id="alert-min-frequency-error" className="helper-text helper-text--error" role="alert">
                  <AlertCircle size={13} aria-hidden="true" /> {t('alerts.error.minFrequency')}
                </span>
              )}
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
                aria-invalid={stalledMinutesInvalid}
                aria-describedby={stalledMinutesInvalid ? 'alert-stalled-minutes-error' : undefined}
              />
              {stalledMinutesInvalid && (
                <span id="alert-stalled-minutes-error" className="helper-text helper-text--error" role="alert">
                  <AlertCircle size={13} aria-hidden="true" /> {t('alerts.error.stalledMinutes')}
                </span>
              )}
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
          {form.trigger === 'workflow.schedule_anomaly' && (
            <label>
              {t('alerts.form.workflowIds')}
              <input
                type="text"
                value={form.workflowIds}
                onChange={(e) => setForm({ ...form, workflowIds: e.target.value })}
                placeholder={t('alerts.form.placeholder.workflowIds')}
              />
            </label>
          )}
          {form.trigger === 'credential.expiring' && (
            <>
              <label>
                {t('alerts.form.warnDays')}
                <input
                  type="number"
                  value={form.warnDays}
                  min={1}
                  max={365}
                  onChange={(e) => setForm({ ...form, warnDays: Number(e.target.value) || 14 })}
                  aria-invalid={warnDaysInvalid}
                  aria-describedby={warnDaysInvalid ? 'alert-warn-days-error' : undefined}
                />
                {warnDaysInvalid && (
                  <span id="alert-warn-days-error" className="helper-text helper-text--error" role="alert">
                    <AlertCircle size={13} aria-hidden="true" /> {t('alerts.error.warnDays')}
                  </span>
                )}
              </label>
              <label>
                {t('alerts.form.credentialKinds')}
                <input
                  type="text"
                  value={form.credentialKinds}
                  onChange={(e) => setForm({ ...form, credentialKinds: e.target.value })}
                  placeholder={t('alerts.form.placeholder.credentialKinds')}
                />
              </label>
              <label>
                {t('alerts.form.credentialNames')}
                <input
                  type="text"
                  value={form.credentialNames}
                  onChange={(e) => setForm({ ...form, credentialNames: e.target.value })}
                  placeholder={t('alerts.form.placeholder.credentialNames')}
                />
              </label>
            </>
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
                <div key={channel._key} className="we-alert-policies__channel">
                  <select
                    aria-label={t('alerts.form.channelDestination')}
                    value={dest}
                    onChange={(e) => {
                      const newChannels = [...form.channels]
                      newChannels[idx] = {
                        destination: e.target.value as AlertDestination,
                        credentialName: '',
                        params: {},
                        _key: channel._key,
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
                      placeholder={t('alerts.form.placeholder.webhookUrl')}
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
                  {dest === 'slack'
                    && (form.trigger === 'recovery_item.created' || form.trigger === 'recovery_item.sla_breached')
                    && (
                      <select
                        aria-label={t('alerts.form.slackInteraction')}
                        value={(params as { interactionConnectionId?: string }).interactionConnectionId ?? ''}
                        onChange={(e) => {
                          const newChannels = [...form.channels]
                          const interactionConnectionId = e.target.value
                          newChannels[idx] = {
                            ...channel,
                            params: interactionConnectionId ? { interactionConnectionId } : {},
                          }
                          setForm({ ...form, channels: newChannels })
                        }}
                      >
                        <option value="">{t('alerts.form.slackInteractionNone')}</option>
                        {slackInteractions.map((connection) => (
                          <option key={connection.id} value={connection.id} disabled={!connection.enabled}>
                            {connection.enabled
                              ? connection.name
                              : t('alerts.form.slackInteractionDisabled', { name: connection.name })}
                          </option>
                        ))}
                      </select>
                    )}
                  {dest === 'email' && (
                    <input
                      type="email"
                      placeholder={t('alerts.form.placeholder.emailTo')}
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
                        placeholder={t('alerts.form.placeholder.githubOwner')}
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
                        placeholder={t('alerts.form.placeholder.githubRepo')}
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
                  <Button variant="ghost" size="sm"
                    type="button"

                    onClick={() => {
                      const newChannels = form.channels.filter((_, i) => i !== idx)
                      setForm({
                        ...form,
                        channels: newChannels.length > 0 ? newChannels : EMPTY_FORM.channels,
                      })
                    }}
                  >
                    <Trash2 size={12} aria-hidden />
                  </Button>
                </div>
              )
            })}
            {form.channels.length < 5 && (
              <Button variant="ghost" size="sm"
                type="button"

                onClick={() =>
                  setForm({
                    ...form,
                    channels: [
                      ...form.channels,
                      { destination: 'slack', credentialName: '', params: {}, _key: newChannelKey() },
                    ],
                  })
                }
              >
                + {t('alerts.form.addChannel')}
              </Button>
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
              aria-invalid={cooldownInvalid}
              aria-describedby={cooldownInvalid ? 'alert-cooldown-error' : undefined}
            />
            {cooldownInvalid && (
              <span id="alert-cooldown-error" className="helper-text helper-text--error" role="alert">
                <AlertCircle size={13} aria-hidden="true" /> {t('alerts.error.cooldownSeconds')}
              </span>
            )}
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
            <Button variant="primary" size="sm"
              type="button"

              onClick={submitPolicy}
              disabled={!canWrite || submitting || form.name.trim().length === 0 || minFrequencyInvalid || stalledMinutesInvalid || warnDaysInvalid || cooldownInvalid}
            >
              {submitting
                ? t('alerts.form.submitting')
                : editingId
                ? t('alerts.form.saveChanges')
                : t('alerts.form.save')}
            </Button>
            <Button variant="ghost" size="sm"
              type="button"

              onClick={cancelForm}
            >
              {t('alerts.form.cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="we-alert-policies__list" data-testid="alert-policies-list">
        {loading && <LoadingSkeleton rows={3} label={t('common.loading')} />}
        {!loading && policies.length === 0 && (
          <EmptyState
            icon={<BellOff />}
            kicker={t('alerts.panel.emptyKicker')}
            body={t('alerts.panel.empty')}
            cta={showForm ? undefined : { label: t('alerts.panel.new'), onClick: () => setShowForm(true) }}
            testId="alert-policies-empty"
          />
        )}
        {!loading &&
          policies.map((policy) => (
            <div key={policy.id} className="we-list-row" data-testid="alert-policy-row">
              <div className="we-list-row__main">
                <strong>{policy.name}</strong>
                <span className="we-pill" data-tone="neutral">
                  {t(`alerts.triggers.${policy.trigger}`)}
                </span>
                <span className="we-list-row__hint">
                  {t('alerts.row.cooldown', { seconds: policy.cooldownSeconds })} ·{' '}
                  {t('alerts.row.channels', { count: policy.channels.length })}
                </span>
              </div>
              <div className="we-list-row__actions">
                <Button variant="ghost" size="sm"
                  type="button"

                  onClick={() => startEdit(policy)}
                  disabled={!canWrite}
                  aria-label={t('alerts.action.edit')}
                  data-testid="alert-policy-edit"
                >
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="sm"
                  type="button"

                  onClick={() => toggleEnabled(policy)}
                  disabled={!canWrite}
                  aria-label={
                    policy.enabled ? t('alerts.action.disable') : t('alerts.action.enable')
                  }
                >
                  {policy.enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                </Button>
                <Button variant="ghost" size="sm"
                  type="button"

                  onClick={() => deletePolicy(policy)}
                  disabled={!canWrite}
                  aria-label={t('alerts.action.delete')}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}
      </div>
    </section>
  )
}
