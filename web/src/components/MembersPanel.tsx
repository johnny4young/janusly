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

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CircleCheck, Crown, Info, Trash2, UserPlus } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole } from '../types'
import { tApiError, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { currentSessionOrganization, sessionCan } from '../identity-context'
import { Button } from './ui/Button'
import { FieldStack, FormActions, FormField } from './ui/Form'

type OrgRoleEntry = {
  name: string
  isBuiltin: boolean
  inheritsFrom: OrgRole
  description: string | null
}

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

/** Render the members list with invite form + per-row role / remove controls. */
export function MembersPanel() {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const identityContext = useWorkflowStore(state => state.identityContext)
  const setIdentityContext = useWorkflowStore(state => state.setIdentityContext)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [orgRoles, setOrgRoles] = useState<OrgRoleEntry[]>([
    { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
    { name: 'editor', isBuiltin: true, inheritsFrom: 'editor', description: null },
    { name: 'admin', isBuiltin: true, inheritsFrom: 'admin', description: null },
  ])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('viewer')
  const [pending, setPending] = useState(false)
  // Inline two-step confirm before removing a member (no native confirm()):
  // holds the userId whose Remove is awaiting confirmation.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [confirmTransferId, setConfirmTransferId] = useState<string | null>(null)
  const trimmedEmail = email.trim()
  const emailInvalid = trimmedEmail.length > 0 && !emailPattern.test(trimmedEmail)
  const canManageMembers = sessionCan(identityContext, 'members.write')
  const canSetRoles = sessionCan(identityContext, 'members.role_set')
  const currentOrganization = currentSessionOrganization(identityContext)
  const canInvite = canManageMembers && emailPattern.test(trimmedEmail) && !pending
  const roleLabel = (name: string) => name === 'viewer' || name === 'editor' || name === 'admin'
    ? t(`userMenu.role.${name}`)
    : name

  const load = useCallback(async () => {
    try {
      const data = await api('/members')
      setMembers(Array.isArray(data) ? data : [])
    } catch (error) {
      addToast(tApiError(error) || (t('members.loadFailed')), 'error')
    }
  }, [addToast, t])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false
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
  }, [platformVersion])

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
      await load()
    } catch (error) {
      addToast(tApiError(error) || (t('members.inviteFailed')), 'error')
    } finally {
      setPending(false)
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
      </section>

      {members.length === 0 && (
        <EmptyState
          icon={<CircleCheck />}
          kicker={t('emptyState.members.kicker')}
          body={t('emptyState.members.body')}
          testId="members-empty"
        />
      )}

      {members.length > 0 && (
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
                    <select
                      className="text-field text-field--compact"
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
                    </select>
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
    </div>
  )
}
