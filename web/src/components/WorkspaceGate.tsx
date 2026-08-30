/**
 * Account-to-workspace bridge shown after provider authentication.
 *
 * Handles the states tenant routes cannot: zero memberships, multiple
 * memberships without a selection, and pending invitations. Selecting a
 * workspace updates only the local scope preference; the API still validates
 * the corresponding `org_members` grant on every tenant request.
 *
 * Used by `App.tsx` before the main operator shell is mounted.
 */

import { useState, type FormEvent } from 'react'
import { Building2, Check, LogOut, Plus, UserRound } from 'lucide-react'

import { api } from '../api'
import { AuthProvider } from '../auth'
import type { SessionContext } from '../identity-context'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { BrandMark } from './BrandMark'
import { Button } from './ui/Button'
import { FormField, FormGrid } from './ui/Form'
import { StatusSummary } from './ui/StatusSummary'

type WorkspaceGateProps = {
  context: SessionContext
}

/** Choose, create, or join a legitimate organization before tenant bootstrap. */
export function WorkspaceGate({ context }: WorkspaceGateProps) {
  const { t } = useT()
  const setAuth = useWorkflowStore((state) => state.setAuth)
  const setIdentityContext = useWorkflowStore((state) => state.setIdentityContext)
  const clearAuth = useWorkflowStore((state) => state.clearAuth)
  const [organizationName, setOrganizationName] = useState('')
  const [profileName, setProfileName] = useState(context.profile.name ?? '')
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const commitContext = async (next: SessionContext) => {
    if (!next.currentOrganizationId) return
    const { auth } = await AuthProvider.updateOrg(next.currentOrganizationId)
    setAuth(auth)
    setIdentityContext(next)
  }

  const selectOrganization = async (organizationId: string) => {
    const organization = context.organizations.find((item) => item.id === organizationId && item.usable)
    if (!organization) return
    setError(null)
    setPendingKey(`organization:${organizationId}`)
    try {
      await commitContext({
        ...context,
        currentOrganizationId: organizationId,
        selectionRequired: false,
        needsOrganization: false,
      })
    } catch (cause) {
      setError(tApiError(cause) || t('auth.workspace.selectFailed'))
    } finally {
      setPendingKey(null)
    }
  }

  const createOrganization = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setPendingKey('create')
    try {
      const next = await api('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: organizationName, profileName: profileName || null }),
      }) as SessionContext
      await commitContext(next)
    } catch (cause) {
      setError(tApiError(cause) || t('auth.workspace.createFailed'))
    } finally {
      setPendingKey(null)
    }
  }

  const acceptInvitation = async (invitationId: string) => {
    setError(null)
    setPendingKey(`invitation:${invitationId}`)
    try {
      const next = await api('/auth/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ invitationId }),
      }) as SessionContext
      await commitContext(next)
    } catch (cause) {
      setError(tApiError(cause) || t('auth.workspace.acceptFailed'))
    } finally {
      setPendingKey(null)
    }
  }

  const signOut = async () => {
    setPendingKey('signout')
    try {
      await AuthProvider.signOut()
      clearAuth()
    } catch (cause) {
      setError(tApiError(cause) || t('toasts.signOutFailed'))
      setPendingKey(null)
    }
  }

  const canCreate = context.identity.mode === 'supabase' || context.identity.mode === 'dev-headers'

  return (
    <main className="auth-screen workspace-gate">
      <section className="workspace-gate__card" aria-labelledby="workspace-gate-title">
        <header className="workspace-gate__header">
          <div className="brand-lockup auth-card__brand">
            <BrandMark size={36} />
            <div>
              <strong>{t('app.brand')}</strong>
              <span>{t('app.brandSubtitle')}</span>
            </div>
          </div>
          <button
            type="button"
            className="workspace-gate__signout"
            onClick={signOut}
            disabled={pendingKey !== null}
          >
            <LogOut size={14} aria-hidden="true" />
            <span>{t('userMenu.item.signOut')}</span>
          </button>
        </header>

        <div className="workspace-gate__intro">
          <span className="workspace-gate__eyebrow">
            <UserRound size={13} aria-hidden="true" />
            {context.profile.email ?? context.identity.email ?? context.identity.userId}
          </span>
          <h1 id="workspace-gate-title">
            {context.selectionRequired ? t('auth.workspace.chooseTitle') : t('auth.workspace.welcomeTitle')}
          </h1>
          <p>
            {context.selectionRequired ? t('auth.workspace.chooseDescription') : t('auth.workspace.welcomeDescription')}
          </p>
        </div>

        {error && <StatusSummary role="alert" tone="danger" title={error} />}

        {context.organizations.length > 0 && (
          <section className="workspace-gate__section" aria-labelledby="workspace-list-title">
            <h2 id="workspace-list-title">{t('auth.workspace.yourOrganizations')}</h2>
            <div className="workspace-gate__list">
              {context.organizations.map((organization) => (
                <button
                  type="button"
                  className="workspace-gate__option"
                  key={organization.id}
                  onClick={() => selectOrganization(organization.id)}
                  disabled={!organization.usable || pendingKey !== null}
                >
                  <span className="workspace-gate__icon"><Building2 size={16} aria-hidden="true" /></span>
                  <span className="workspace-gate__option-body">
                    <strong>{organization.name}</strong>
                    <small>{organization.role}</small>
                  </span>
                  {pendingKey === `organization:${organization.id}` ? (
                    <span>{t('common.working')}</span>
                  ) : (
                    <Check size={16} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {context.invitations.length > 0 && (
          <section className="workspace-gate__section" aria-labelledby="workspace-invites-title">
            <h2 id="workspace-invites-title">{t('auth.workspace.invitations')}</h2>
            <div className="workspace-gate__list">
              {context.invitations.map((invitation) => (
                <button
                  type="button"
                  className="workspace-gate__option workspace-gate__option--invite"
                  key={invitation.id}
                  onClick={() => acceptInvitation(invitation.id)}
                  disabled={pendingKey !== null}
                >
                  <span className="workspace-gate__icon"><Building2 size={16} aria-hidden="true" /></span>
                  <span className="workspace-gate__option-body">
                    <strong>{invitation.organizationName}</strong>
                    <small>{t('auth.workspace.invitedAs', { role: invitation.role })}</small>
                  </span>
                  <span>{pendingKey === `invitation:${invitation.id}` ? t('common.working') : t('auth.workspace.accept')}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {canCreate && (
          <form className="workspace-gate__create" onSubmit={createOrganization}>
            <div className="workspace-gate__section-heading">
              <div>
                <h2>{t('auth.workspace.createTitle')}</h2>
                <p>{t('auth.workspace.createDescription')}</p>
              </div>
              <Plus size={18} aria-hidden="true" />
            </div>
            <FormGrid>
              <FormField id="workspace-profile-name" label={t('auth.workspace.profileName')}>
                {(controlProps) => (
                  <input
                    {...controlProps}
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    autoComplete="name"
                    maxLength={100}
                    placeholder={t('auth.workspace.profileNamePlaceholder')}
                  />
                )}
              </FormField>
              <FormField id="workspace-organization-name" label={t('auth.workspace.organizationName')} required>
                {(controlProps) => (
                  <input
                    {...controlProps}
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    autoComplete="organization"
                    required
                    minLength={2}
                    maxLength={80}
                    placeholder={t('auth.workspace.organizationNamePlaceholder')}
                  />
                )}
              </FormField>
            </FormGrid>
            <Button
              type="submit"
              className="workspace-gate__create-action"
              variant="primary"
              disabled={pendingKey !== null || organizationName.trim().length < 2}
              loading={pendingKey === 'create'}
              loadingLabel={t('common.working')}
              leadingIcon={<Plus size={15} />}
            >
              {t('auth.workspace.createAction')}
            </Button>
          </form>
        )}
      </section>
    </main>
  )
}
