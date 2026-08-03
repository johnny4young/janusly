/**
 * Admin surface for signed Slack recovery actions.
 *
 * Connections bind one Slack team to an environment-backed signing-secret
 * credential and an explicit Slack-user → organization-member map. Secret
 * values never reach this component; it only handles credential names and the
 * opaque callback URL that administrators copy into Slack app configuration.
 */

import { useEffect, useState } from 'react'
import { Copy, MessageSquareMore, Pencil, Plus, Save, Trash2, X } from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'

type SlackUserMapping = { slackUserId: string; userId: string }
type SlackConnection = {
  id: string
  name: string
  teamId: string
  signingCredentialName: string
  userMappings: SlackUserMapping[]
  enabled: boolean
  callbackUrl: string
  createdAt: string
  updatedAt: string
}
type Credential = { id: string; name: string; kind: string }
type Member = { userId: string; email?: string | null; role?: string | null }
type FormMapping = SlackUserMapping & { key: string }
type ConnectionForm = {
  name: string
  teamId: string
  signingCredentialName: string
  userMappings: FormMapping[]
  enabled: boolean
}

const emptyForm = (): ConnectionForm => ({
  name: '',
  teamId: '',
  signingCredentialName: '',
  userMappings: [{ slackUserId: '', userId: '', key: crypto.randomUUID() }],
  enabled: true,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseConnections(value: unknown): SlackConnection[] {
  if (!isRecord(value)) return []
  const rows = (value as { connections?: unknown }).connections
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is SlackConnection => {
    if (!isRecord(row)) return false
    const item = row as Partial<SlackConnection>
    return typeof item.id === 'string'
      && typeof item.name === 'string'
      && typeof item.teamId === 'string'
      && typeof item.signingCredentialName === 'string'
      && Array.isArray(item.userMappings)
      && item.userMappings.every((mapping) => isRecord(mapping)
        && typeof mapping.slackUserId === 'string'
        && typeof mapping.userId === 'string')
      && typeof item.enabled === 'boolean'
      && typeof item.callbackUrl === 'string'
      && typeof item.createdAt === 'string'
      && typeof item.updatedAt === 'string'
  })
}

function parseCredentials(value: unknown): Credential[] {
  if (!Array.isArray(value)) return []
  return value.filter((credential): credential is Credential => isRecord(credential)
    && typeof credential.id === 'string'
    && typeof credential.name === 'string'
    && credential.kind === 'slack_signing_secret')
}

function parseMembers(value: unknown): Member[] {
  if (!Array.isArray(value)) return []
  return value.filter((member): member is Member => isRecord(member)
    && typeof member.userId === 'string'
    && (member.email === undefined || member.email === null || typeof member.email === 'string')
    && (member.role === undefined || member.role === null || typeof member.role === 'string'))
}

export function SlackInteractionsPanel() {
  const { t } = useT()
  const confirmDialog = useConfirm()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [connections, setConnections] = useState<SlackConnection[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [form, setForm] = useState<ConnectionForm>(() => emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api('/integrations/slack/interactions'),
      api('/credentials').catch(() => []),
      api('/members').catch(() => []),
    ])
      .then(([connectionResponse, credentialResponse, memberResponse]) => {
        if (cancelled) return
        setConnections(parseConnections(connectionResponse))
        setCredentials(parseCredentials(credentialResponse))
        setMembers(parseMembers(memberResponse))
      })
      .catch((loadError) => {
        if (!cancelled) setError(tApiError(loadError) || t('slackInteractions.error.load'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  function closeForm() {
    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm())
  }

  function edit(connection: SlackConnection) {
    setEditingId(connection.id)
    setForm({
      name: connection.name,
      teamId: connection.teamId,
      signingCredentialName: connection.signingCredentialName,
      userMappings: connection.userMappings.length > 0
        ? connection.userMappings.map((mapping) => ({ ...mapping, key: crypto.randomUUID() }))
        : emptyForm().userMappings,
      enabled: connection.enabled,
    })
    setShowForm(true)
  }

  const populatedMappings = form.userMappings.filter((mapping) =>
    mapping.slackUserId.trim().length > 0 || mapping.userId.length > 0)
  const mappingsComplete = populatedMappings.every((mapping) =>
    mapping.slackUserId.trim().length > 0 && mapping.userId.length > 0)
  const uniqueSlackIds = new Set(populatedMappings.map((mapping) => mapping.slackUserId.trim())).size
    === populatedMappings.length
  const canSave = form.name.trim().length > 0
    && form.teamId.trim().length > 0
    && form.signingCredentialName.length > 0
    && mappingsComplete
    && uniqueSlackIds
    && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        teamId: form.teamId.trim(),
        signingCredentialName: form.signingCredentialName,
        userMappings: populatedMappings.map((mapping) => ({
          slackUserId: mapping.slackUserId.trim(),
          userId: mapping.userId,
        })),
        enabled: form.enabled,
      }
      await api(editingId
        ? `/integrations/slack/interactions/${encodeURIComponent(editingId)}`
        : '/integrations/slack/interactions', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      addToast(t(editingId ? 'slackInteractions.toast.updated' : 'slackInteractions.toast.created'), 'success')
      closeForm()
      bumpPlatformVersion()
    } catch (saveError) {
      addToast(tApiError(saveError) || t('slackInteractions.error.save'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function remove(connection: SlackConnection) {
    if (!(await confirmDialog({
      body: t('slackInteractions.confirm.delete', { name: connection.name }),
      tone: 'danger',
    }))) return
    try {
      await api(`/integrations/slack/interactions/${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
      addToast(t('slackInteractions.toast.deleted'), 'success')
      bumpPlatformVersion()
    } catch (deleteError) {
      addToast(tApiError(deleteError) || t('slackInteractions.error.delete'), 'error')
    }
  }

  async function copyCallback(connection: SlackConnection) {
    try {
      await navigator.clipboard.writeText(connection.callbackUrl)
      addToast(t('slackInteractions.toast.copied'), 'success')
    } catch {
      addToast(t('slackInteractions.error.copy'), 'error')
    }
  }

  return (
    <section className="we-card we-slack-interactions" aria-labelledby="slack-interactions-heading">
      <div className="we-card__header">
        <div>
          <div className="section-kicker">{t('slackInteractions.kicker')}</div>
          <h3 id="slack-interactions-heading">
            <MessageSquareMore size={16} aria-hidden /> {t('slackInteractions.title')}
          </h3>
        </div>
        <button
          type="button"
          className="we-btn we-btn--ghost we-btn--sm"
          onClick={() => showForm ? closeForm() : setShowForm(true)}
        >
          {showForm ? <X size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          {t(showForm ? 'slackInteractions.action.cancel' : 'slackInteractions.action.new')}
        </button>
      </div>
      <p className="helper-text we-slack-interactions__intro">{t('slackInteractions.intro')}</p>

      {showForm && (
        <div className="we-slack-interactions__form" data-testid="slack-interaction-form">
          <label>
            {t('slackInteractions.form.name')}
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              maxLength={120}
            />
          </label>
          <label>
            {t('slackInteractions.form.teamId')}
            <input
              value={form.teamId}
              onChange={(event) => setForm({ ...form, teamId: event.target.value })}
              placeholder="T0123456789"
              maxLength={64}
              autoComplete="off"
            />
          </label>
          <label>
            {t('slackInteractions.form.credential')}
            <select
              value={form.signingCredentialName}
              onChange={(event) => setForm({ ...form, signingCredentialName: event.target.value })}
            >
              <option value="">{t('slackInteractions.form.pickCredential')}</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.name}>{credential.name}</option>
              ))}
            </select>
          </label>
          {credentials.length === 0 && (
            <p className="helper-text" role="status">{t('slackInteractions.form.noCredentials')}</p>
          )}
          <fieldset className="we-slack-interactions__mappings">
            <legend>{t('slackInteractions.form.mappings')}</legend>
            {form.userMappings.map((mapping, index) => (
              <div className="we-slack-interactions__mapping" key={mapping.key}>
                <input
                  value={mapping.slackUserId}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    userMappings: current.userMappings.map((row) => row.key === mapping.key
                      ? { ...row, slackUserId: event.target.value }
                      : row),
                  }))}
                  aria-label={t('slackInteractions.form.slackUser', { number: index + 1 })}
                  placeholder="U0123456789"
                  maxLength={128}
                  autoComplete="off"
                />
                <select
                  value={mapping.userId}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    userMappings: current.userMappings.map((row) => row.key === mapping.key
                      ? { ...row, userId: event.target.value }
                      : row),
                  }))}
                  aria-label={t('slackInteractions.form.member', { number: index + 1 })}
                >
                  <option value="">{t('slackInteractions.form.pickMember')}</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.email || member.userId}{member.role ? ` · ${member.role}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--sm"
                  aria-label={t('slackInteractions.form.removeMapping', { number: index + 1 })}
                  onClick={() => setForm((current) => {
                    const next = current.userMappings.filter((row) => row.key !== mapping.key)
                    return { ...current, userMappings: next.length > 0 ? next : emptyForm().userMappings }
                  })}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="we-btn we-btn--ghost we-btn--sm"
              onClick={() => setForm((current) => ({
                ...current,
                userMappings: [...current.userMappings, {
                  slackUserId: '',
                  userId: '',
                  key: crypto.randomUUID(),
                }],
              }))}
            >
              <Plus size={13} aria-hidden /> {t('slackInteractions.form.addMapping')}
            </button>
          </fieldset>
          {!uniqueSlackIds && (
            <p className="helper-text helper-text--error" role="alert">{t('slackInteractions.form.duplicateSlackUser')}</p>
          )}
          <label className="we-slack-interactions__enabled">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            {t('slackInteractions.form.enabled')}
          </label>
          <button
            type="button"
            className="we-btn we-btn--primary we-btn--sm"
            disabled={!canSave}
            onClick={() => void save()}
          >
            <Save size={14} aria-hidden />
            {t(saving ? 'slackInteractions.action.saving' : editingId
              ? 'slackInteractions.action.saveChanges'
              : 'slackInteractions.action.create')}
          </button>
        </div>
      )}

      {loading && <LoadingSkeleton rows={3} />}
      {error && <p className="helper-text helper-text--error" role="alert">{error}</p>}
      {!loading && !error && connections.length === 0 && (
        <EmptyState
          icon={<MessageSquareMore />}
          kicker={t('slackInteractions.empty.kicker')}
          body={t('slackInteractions.empty.body')}
          testId="slack-interactions-empty"
        />
      )}
      {!loading && connections.length > 0 && (
        <ul className="we-slack-interactions__list">
          {connections.map((connection) => (
            <li className="we-list-row" key={connection.id} data-testid={`slack-interaction-${connection.id}`}>
              <div className="we-list-row__main">
                <div className="we-list-row__title">
                  <strong>{connection.name}</strong>
                  <span className="we-pill" data-tone={connection.enabled ? 'success' : 'neutral'}>
                    {t(connection.enabled ? 'slackInteractions.status.enabled' : 'slackInteractions.status.disabled')}
                  </span>
                </div>
                <span className="we-list-row__hint">
                  {connection.teamId} · {t('slackInteractions.row.mappings', { count: connection.userMappings.length })}
                </span>
                <code className="we-slack-interactions__callback">{connection.callbackUrl}</code>
              </div>
              <div className="we-list-row__actions">
                <button
                  type="button"
                  className="we-btn we-btn--ghost we-btn--sm"
                  onClick={() => void copyCallback(connection)}
                >
                  <Copy size={13} aria-hidden /> {t('slackInteractions.action.copy')}
                </button>
                <button type="button" className="we-btn we-btn--ghost we-btn--sm" onClick={() => edit(connection)}>
                  <Pencil size={13} aria-hidden /> {t('slackInteractions.action.edit')}
                </button>
                <button type="button" className="we-btn we-btn--ghost we-btn--sm" onClick={() => void remove(connection)}>
                  <Trash2 size={13} aria-hidden /> {t('slackInteractions.action.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
