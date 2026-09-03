/**
 * Org members panel — invite by email + role, change a member's role,
 * remove a member. Calls `bumpPlatformVersion()` after every mutation so
 * cross-panel state (RBAC checks elsewhere) refetches.
 *
 * Used by `RightPanel.tsx` (the `members` tab).
 *
 * Invariants:
 * - The role list is dynamic — built-ins (`viewer`/`editor`/`admin`)
 *   PLUS any custom roles defined for this org via the permission-
 *   grants admin UI. Sourced from `GET /org/roles`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CircleCheck, Crown, Info, Mail, RefreshCw, Trash2, UserPlus } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { useWorkflowStore } from '../store'
import type { OrgInvitation, OrgMember, OrgRole } from '../types'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { currentSessionOrganization, sessionCan } from '../identity-context'
import { useConfirm } from './ConfirmDialog'
import { Button } from './ui/Button'
import { FieldStack, FormActions, FormField, SelectControl } from './ui/Form'
import { StatusSummary } from './ui/StatusSummary'

type OrgRoleEntry = {
  name: string
  isBuiltin: boolean
  inheritsFrom: OrgRole
  description: string | null
}

const BUILTIN_ROLE_ENTRIES: OrgRoleEntry[] = [
  { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
  { name: 'editor', isBuiltin: true, inheritsFrom: 'editor', description: null },
  { name: 'admin', isBuiltin: true, inheritsFrom: 'admin', description: null },
]

const BUILTIN_ROLE_COPY_KEYS: Record<OrgRole, string> = {
  viewer: 'members.role.viewer.copy',
  editor: 'members.role.editor.copy',
  admin: 'members.role.admin.copy',
}

function describeRole(role: string, entry?: OrgRoleEntry): string {
  if (entry && !entry.isBuiltin && entry.description) return entry.description
  if (role === 'viewer' || role === 'editor' || role === 'admin') {
    return runtimeT(BUILTIN_ROLE_COPY_KEYS[role as OrgRole])
  }
  return entry
    ? (runtimeT('members.role.customInherits', { base: entry.inheritsFrom }))
    : (runtimeT('members.role.customDefault'))
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function pendingInvitationsFromResponse(value: unknown): OrgInvitation[] {
  const rows = (value as { invitations?: unknown } | null)?.invitations
  if (!Array.isArray(rows)) return []
  return rows.filter((candidate): candidate is OrgInvitation => {
    if (!candidate || typeof candidate !== 'object') return false
    const row = candidate as Record<string, unknown>
    return typeof row.id === 'string'
      && typeof row.orgId === 'string'
      && typeof row.email === 'string'
      && typeof row.role === 'string'
      && row.status === 'pending'
  })
}

function invitationSentAt(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return null
  return date.toLocaleString(getResolvedLocale())
}

/** Render the members list with invite form + per-row role / remove controls. */
export function MembersPanel() {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const identityContext = useWorkflowStore(state => state.identityContext)
  const setIdentityContext = useWorkflowStore(state => state.setIdentityContext)
  const confirm = useConfirm()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersLoadFailed, setMembersLoadFailed] = useState(false)
  const [invitations, setInvitations] = useState<OrgInvitation[]>([])
  const [invitationsLoading, setInvitationsLoading] = useState(false)
  const [invitationsLoadFailed, setInvitationsLoadFailed] = useState(false)
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)
  const membersRequest = useRef(0)
  const invitationsRequest = useRef(0)
  const [orgRoles, setOrgRoles] = useState<OrgRoleEntry[]>(BUILTIN_ROLE_ENTRIES)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('viewer')
  const [pending, setPending] = useState(false)
  // Inline two-step confirm before removing a member (no native confirm()):
  // holds the userId whose Remove is awaiting confirmation.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [confirmTransferId, setConfirmTransferId] = useState<string | null>(null)
  const trimmedEmail = email.trim()
  const emailInvalid = trimmedEmail.length > 0 && !emailPattern.test(trimmedEmail)
  const currentOrganization = currentSessionOrganization(identityContext)
  const isAdminRole = currentOrganization?.roleBase === 'admin'
  const canManageMembers = isAdminRole && sessionCan(identityContext, 'members.write')
  const canSetRoles = isAdminRole && sessionCan(identityContext, 'members.role_set')
  const activeOrganizationId = currentOrganization?.id ?? ''
  const canInvite = canManageMembers && emailPattern.test(trimmedEmail) && !pending
  const roleLabel = (name: string) => name === 'viewer' || name === 'editor' || name === 'admin'
    ? t(`userMenu.role.${name}`)
    : name

  const load = useCallback(async () => {
    const request = ++membersRequest.current
    setMembersLoading(true)
    setMembersLoadFailed(false)
    try {
      const data = await api('/members')
      if (request !== membersRequest.current) return
      setMembers(Array.isArray(data) ? data : [])
    } catch {
      if (request !== membersRequest.current) return
      setMembersLoadFailed(true)
    } finally {
      if (request === membersRequest.current) setMembersLoading(false)
    }
  }, [activeOrganizationId])

  const loadInvitations = useCallback(async () => {
    const request = ++invitationsRequest.current
    if (!canManageMembers) {
      setInvitations([])
      setInvitationsLoading(false)
      setInvitationsLoadFailed(false)
      return
    }
    setInvitationsLoading(true)
    setInvitationsLoadFailed(false)
    try {
      const data = await api('/members/invitations')
      if (request !== invitationsRequest.current) return
      setInvitations(pendingInvitationsFromResponse(data))
    } catch {
      if (request !== invitationsRequest.current) return
      setInvitationsLoadFailed(true)
    } finally {
      if (request === invitationsRequest.current) setInvitationsLoading(false)
    }
  }, [activeOrganizationId, canManageMembers])

  useEffect(() => {
    setMembers([])
    void load()
    return () => { membersRequest.current += 1 }
  }, [load])

  useEffect(() => {
    setInvitations([])
    void loadInvitations()
    return () => { invitationsRequest.current += 1 }
  }, [loadInvitations])

  useEffect(() => {
    let cancelled = false
    // Never carry a custom role from the previous organization while the
    // active tenant's role catalog is loading (or if that load fails).
    setOrgRoles(BUILTIN_ROLE_ENTRIES)
    api('/org/roles')
      .then((data) => {
        if (cancelled) return
        const rows = (data as { roles?: OrgRoleEntry[] })?.roles
        if (Array.isArray(rows) && rows.length > 0) setOrgRoles(rows)
      })
      .catch(() => {
        // Non-fatal: fall back to built-ins.
      })
    return () => {
      cancelled = true
    }
  }, [activeOrganizationId, platformVersion])

  const invite = async () => {
    const trimmed = email.trim()
    if (!emailPattern.test(trimmed)) {
      addToast(t('members.invalidEmail'), 'error')
      return
    }

    setPending(true)
    try {
      await api('/members/invite', {
        method: 'POST',
        body: JSON.stringify({ email: trimmed, role }),
      })
      addToast(t('members.toastInvited', { email: trimmed }), 'success')
      setEmail('')
      // Reset the role to the least-privilege default so the next invite
      // doesn't silently reuse the previous (possibly elevated) selection.
      setRole('viewer')
      bumpPlatformVersion()
      await Promise.all([load(), loadInvitations()])
    } catch (error) {
      addToast(tApiError(error) || (t('members.inviteFailed')), 'error')
    } finally {
      setPending(false)
    }
  }

  const revokeInvitation = async (invitation: OrgInvitation) => {
    const accepted = await confirm({
      title: t('members.invitations.revokeTitle'),
      body: t('members.invitations.revokeConfirm', { email: invitation.email }),
      confirmLabel: t('members.invitations.revoke'),
      tone: 'danger',
    })
    if (!accepted) return
    setRevokingInvitationId(invitation.id)
    try {
      await api(`/members/invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: 'POST' })
      addToast(t('members.invitations.revokeDone', { email: invitation.email }), 'success')
      bumpPlatformVersion()
      await loadInvitations()
    } catch (error) {
      addToast(tApiError(error) || t('members.invitations.revokeFailed'), 'error')
    } finally {
      setRevokingInvitationId(null)
    }
  }

  const updateRole = async (userId: string, nextRole: string) => {
    try {
      await api('/members/role', {
        method: 'POST',
        body: JSON.stringify({ userId, role: nextRole }),
      })
      addToast(t('members.toastRoleUpdated'), 'success')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(tApiError(error) || (t('members.updateFailed')), 'error')
    }
  }

  const remove = async (userId: string) => {
    setConfirmRemoveId(null)
    try {
      await api(`/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
      addToast(t('members.toastRemoved'), 'success')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(tApiError(error) || (t('members.removeFailed')), 'error')
    }
  }

  const transferOwnership = async (userId: string) => {
    setConfirmTransferId(null)
    try {
      await api('/organizations/owner', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      })
      if (identityContext?.currentOrganizationId) {
        setIdentityContext({
          ...identityContext,
          organizations: identityContext.organizations.map(organization => (
            organization.id === identityContext.currentOrganizationId
              ? { ...organization, isOwner: false }
              : organization
          )),
        })
      }
      addToast(t('members.toastOwnershipTransferred'), 'success')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(tApiError(error) || t('members.transferFailed'), 'error')
    }
  }

  return (
    <div className="panel-list">
      <section className="we-card" aria-labelledby="members-invite-title" data-testid="members-invite-panel">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('members.kicker')}</div>
            <h3 id="members-invite-title">{t('members.heading')}</h3>
          </div>
          <span className="mode-pill mode-pill-neutral">
            {t('members.inviteAs', { role: roleLabel(role) })}
          </span>
        </div>
        <FieldStack disabled={!canManageMembers} labelledBy="members-invite-title">
          <FormField
            id="member-email"
            label={t('members.email')}
            required
            error={emailInvalid ? (
              <><AlertCircle size={13} aria-hidden="true" /> {t('members.invalidEmail')}</>
            ) : undefined}
          >
            {(controlProps) => (
              <input
                {...controlProps}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('members.emailPlaceholder')}
                type="email"
                autoComplete="off"
                required
              />
            )}
          </FormField>
          <div className="ui-field">
            <span className="ui-field__label" id="member-role-label">{t('members.role')}</span>
            <div className="we-role-options" role="radiogroup" aria-labelledby="member-role-label">
              {orgRoles.map(option => {
                const selected = role === option.name
                return (
                  <label key={option.name} className="we-role-option" data-selected={selected}>
                    <input
                      type="radio"
                      name="invite-role"
                      value={option.name}
                      checked={selected}
                      onChange={() => setRole(option.name)}
                    />
                    <span className="we-role-option__copy">
                      <span className="we-role-option__name">
                        {roleLabel(option.name)}{option.isBuiltin ? '' : (t('members.role.customSuffix'))}
                      </span>
                      <span className="we-role-option__desc">{describeRole(option.name, option)}</span>
                    </span>
                    <span className="we-role-option__radio" aria-hidden="true" />
                  </label>
                )
              })}
            </div>
            <span className="ui-field__hint">
              <Info size={13} aria-hidden="true" /> {t('members.leastPrivilege')}
            </span>
          </div>
        </FieldStack>
        <FormActions>
          <Button
            onClick={invite}
            variant="primary"
            disabled={!canInvite}
            loading={pending}
            loadingLabel={t('members.inviting')}
            leadingIcon={<UserPlus size={15} />}
          >
            {t('members.invite')}
          </Button>
        </FormActions>
        {!canManageMembers && (
          <StatusSummary
            icon={<Info size={16} />}
            title={t('members.readOnly.title')}
            description={t('members.readOnly.body')}
            tone="info"
          />
        )}
      </section>

      <section className="we-card" aria-labelledby="members-list-title" data-testid="members-list-panel">
        <header className="we-card__header">
          <div>
            <div className="section-kicker">{t('members.list.kicker')}</div>
            <h3 id="members-list-title">{t('members.list.heading')}</h3>
          </div>
          {!membersLoading && !membersLoadFailed && (
            <span className="mode-pill mode-pill-neutral">
              {t('members.list.count', { count: members.length })}
            </span>
          )}
        </header>

        {membersLoading ? (
          <LoadingSkeleton rows={3} label={t('members.list.loading')} testId="members-loading" />
        ) : membersLoadFailed ? (
          <StatusSummary
            icon={<AlertCircle size={16} />}
            title={t('members.list.loadFailed')}
            description={t('members.list.loadFailedBody')}
            tone="danger"
            role="alert"
            actions={(
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<RefreshCw size={14} />}
                onClick={() => void load()}
              >
                {t('members.list.retry')}
              </Button>
            )}
          />
        ) : members.length === 0 ? (
          <EmptyState
            icon={<CircleCheck />}
            kicker={t('emptyState.members.kicker')}
            body={t('emptyState.members.body')}
            testId="members-empty"
          />
        ) : (
          <ul className="we-list">
            {members.map(member => {
              const label = member.email ?? member.userId
              const initials = (label.includes('@') ? label.split('@')[0] : label).slice(0, 2).toUpperCase()
              const isAdmin = member.role === 'admin'
              const memberRole = orgRoles.find(entry => entry.name === member.role)
              const canReceiveOwnership = currentOrganization?.isOwner === true
                && !member.isOwner
                && (member.role === 'admin' || memberRole?.inheritsFrom === 'admin')
              return (
                <li key={member.id}>
                  <div className="we-list-row" data-testid={`members-row-${member.userId}`} data-severity={isAdmin ? 'cobalt' : undefined}>
                    <span className="we-list-row__avatar" aria-hidden="true">{initials}</span>
                    <div className="we-list-row__body">
                      <strong>
                        {label}
                        {member.isOwner && (
                          <span className="mode-pill mode-pill-neutral" data-testid={`members-owner-${member.userId}`}>
                            <Crown size={12} aria-hidden="true" /> {t('members.owner')}
                          </span>
                        )}
                      </strong>
                      <small>{describeRole(member.role, memberRole)}</small>
                    </div>
                    <div className="we-list-row__meta">
                      <SelectControl
                        value={member.role}
                        onChange={(event) => updateRole(member.userId, event.target.value)}
                        aria-label={t('members.row.roleAria', { member: label })}
                        disabled={!canSetRoles || member.isOwner}
                      >
                        {orgRoles.map(option => (
                          <option key={option.name} value={option.name}>
                            {roleLabel(option.name)}{option.isBuiltin ? '' : (t('members.role.customSuffix'))}
                          </option>
                        ))}
                      </SelectControl>
                      {canReceiveOwnership && (confirmTransferId === member.userId ? (
                        <span className="we-list-row__confirm">
                          <span className="we-list-row__confirm-text">
                            {t('members.row.transferConfirm', { member: label })}
                          </span>
                          <button
                            type="button"
                            className="small-command danger"
                            onClick={() => transferOwnership(member.userId)}
                            data-testid={`members-transfer-confirm-${member.userId}`}
                          >
                            {t('members.row.transferConfirmCta')}
                          </button>
                          <button type="button" className="small-command" onClick={() => setConfirmTransferId(null)}>
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="small-command"
                          onClick={() => setConfirmTransferId(member.userId)}
                          aria-label={t('members.row.transferAria', { member: label })}
                          title={t('members.row.transferTitle')}
                          data-testid={`members-transfer-${member.userId}`}
                        >
                          <Crown size={14} aria-hidden="true" />
                        </button>
                      ))}
                      {!canManageMembers || member.isOwner ? null : confirmRemoveId === member.userId ? (
                        <span className="we-list-row__confirm">
                          <span className="we-list-row__confirm-text">
                            {t('members.row.removeConfirm', { member: label })}
                          </span>
                          <button
                            type="button"
                            className="small-command danger"
                            onClick={() => remove(member.userId)}
                            data-testid={`members-remove-confirm-${member.userId}`}
                          >
                            {t('members.row.removeConfirmCta')}
                          </button>
                          <button
                            type="button"
                            className="small-command"
                            onClick={() => setConfirmRemoveId(null)}
                          >
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="small-command danger"
                          onClick={() => setConfirmRemoveId(member.userId)}
                          aria-label={t('members.row.removeAria', { member: label })}
                          title={t('members.row.removeTitle')}
                          data-testid={`members-remove-${member.userId}`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {canManageMembers && (
        <section className="we-card" aria-labelledby="members-invitations-title" data-testid="members-invitations-panel">
          <header className="we-card__header">
            <div>
              <div className="section-kicker">{t('members.invitations.kicker')}</div>
              <h3 id="members-invitations-title">{t('members.invitations.heading')}</h3>
            </div>
            {!invitationsLoading && !invitationsLoadFailed && (
              <span className="mode-pill mode-pill-neutral">
                {t('members.invitations.count', { count: invitations.length })}
              </span>
            )}
          </header>

          {invitationsLoading ? (
            <LoadingSkeleton rows={2} label={t('members.invitations.loading')} testId="members-invitations-loading" />
          ) : invitationsLoadFailed ? (
            <StatusSummary
              icon={<AlertCircle size={16} />}
              title={t('members.invitations.loadFailed')}
              description={t('members.invitations.loadFailedBody')}
              tone="danger"
              role="alert"
              actions={(
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<RefreshCw size={14} />}
                  onClick={() => void loadInvitations()}
                >
                  {t('members.list.retry')}
                </Button>
              )}
            />
          ) : invitations.length === 0 ? (
            <EmptyState
              icon={<Mail />}
              kicker={t('members.invitations.empty.title')}
              body={t('members.invitations.empty.body')}
              testId="members-invitations-empty"
            />
          ) : (
            <ul className="we-list">
              {invitations.map(invitation => {
                const sentAt = invitationSentAt(invitation.createdAt)
                return (
                  <li key={invitation.id}>
                    <div className="we-list-row" data-testid={`members-invitation-${invitation.id}`} data-severity="warning">
                      <span className="we-list-row__avatar" aria-hidden="true"><Mail size={15} /></span>
                      <div className="we-list-row__body">
                        <strong>{invitation.email}</strong>
                        <small>
                          {t('members.invitations.role', { role: roleLabel(invitation.role) })}
                          {' · '}
                          {sentAt
                            ? t('members.invitations.sentAt', { date: sentAt })
                            : t('members.invitations.awaiting')}
                        </small>
                      </div>
                      <div className="we-list-row__meta">
                        <span className="we-list-row__pill we-list-row__pill--warning">
                          {t('members.invitations.pending')}
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          loading={revokingInvitationId === invitation.id}
                          loadingLabel={t('members.invitations.revoking')}
                          onClick={() => void revokeInvitation(invitation)}
                          aria-label={t('members.invitations.revokeAria', { email: invitation.email })}
                        >
                          {t('members.invitations.revoke')}
                        </Button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
