/**
 * User dropdown — Janusly's account menu.
 *
 * Replaces the legacy 260px popover (org input + locale + logout) with the
 * 320px dropdown documented in `ui_kits/studio/user-menu.html` of the
 * design system zip: identity strip, workspace card with env chip,
 * recent orgs, AI operator status card, Theme + Density segmented controls
 * (wired to localStorage via `theme.ts`), items list (Account / Team /
 * Tokens / Shortcuts / Docs / Sign out), and status footer.
 *
 * Used by `App.tsx` (top-bar header).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  BookOpen,
  Building2,
  ChevronDown,
  DollarSign,
  KeyRound,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  UserCog,
  Users,
} from 'lucide-react'
import { AuthProvider } from '../auth'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { tApiError, useT } from '../i18n'
import type { OnboardingState } from '@janusly/shared/src/onboarding'
import { requestOperationsSection } from './operations-section-bus'
import {
  type DensityPreference,
  type ThemePreference,
  getStoredDensity,
  getStoredTheme,
  setDensity,
  setTheme,
} from '../theme'
import { LocaleSwitcher } from '../i18n/LocaleSwitcher'
import type { ActiveTab, AiHealth } from '../types'
import { parseDocsUrl } from '../docs-link'
import { currentSessionOrganization, sessionCan } from '../identity-context'

type UserMenuProps = {
  aiHealth?: AiHealth | null
  budgetGuardOn?: boolean | null
  /** Validated build-time docs capability; absent hides the menu item. */
  docsUrl?: string | null
  onOpenTab?: (tab: ActiveTab) => void
  onOpenShortcuts?: () => void
}

function initials(label: string | null | undefined): string {
  if (!label) return 'JN'
  const trimmed = label.trim()
  if (!trimmed) return 'JN'
  if (trimmed.includes('@')) {
    const local = trimmed.split('@')[0] ?? ''
    return (local.slice(0, 2) || 'JN').toUpperCase()
  }
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
  return (parts[0]?.slice(0, 2) ?? 'JN').toUpperCase()
}

function displayName(user: unknown, fallback: string): string {
  if (!user || typeof user !== 'object') return fallback
  const meta = (user as { user_metadata?: { full_name?: unknown; name?: unknown }, email?: unknown }).user_metadata
  if (meta && typeof meta.full_name === 'string' && meta.full_name.length > 0) return meta.full_name
  if (meta && typeof meta.name === 'string' && meta.name.length > 0) return meta.name
  const email = (user as { email?: unknown }).email
  if (typeof email === 'string' && email.length > 0) return email.split('@')[0] ?? fallback
  return fallback
}

function displayEmail(user: unknown, fallback: string): string {
  if (!user || typeof user !== 'object') return fallback
  const email = (user as { email?: unknown }).email
  return typeof email === 'string' && email.length > 0 ? email : fallback
}

function resolveEnv(): 'sandbox' | 'production' {
  const mode = (import.meta as { env?: { MODE?: string; PROD?: boolean } }).env
  if (mode?.PROD) return 'production'
  return 'sandbox'
}

export function UserMenu({ aiHealth = null, budgetGuardOn = null, docsUrl = null, onOpenTab, onOpenShortcuts }: UserMenuProps) {
  const { t } = useT()
  const safeDocsUrl = parseDocsUrl(docsUrl)
  const user = useWorkflowStore(state => state.user)
  const userId = useWorkflowStore(state => state.userId)
  const orgId = useWorkflowStore(state => state.orgId)
  const identityContext = useWorkflowStore(state => state.identityContext)
  const clearAuth = useWorkflowStore(state => state.clearAuth)
  const setAuth = useWorkflowStore(state => state.setAuth)
  const setIdentityContext = useWorkflowStore(state => state.setIdentityContext)
  const addToast = useWorkflowStore(state => state.addToast)
  const onboarding = useWorkflowStore(state => state.onboarding)
  const setOnboarding = useWorkflowStore(state => state.setOnboarding)

  const [open, setOpen] = useState(false)
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredTheme())
  const [density, setDensityState] = useState<DensityPreference>(() => getStoredDensity())
  const [workspaceAction, setWorkspaceAction] = useState<string | null>(null)
  const [showWorkspaceCreate, setShowWorkspaceCreate] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  const [showProfileEditor, setShowProfileEditor] = useState(false)
  const [profileName, setProfileName] = useState(identityContext?.profile.name ?? '')
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const identityEmail = identityContext?.profile.email ?? identityContext?.identity.email ?? userId ?? 'dev-user@local'
  const name = displayName(user, identityContext?.profile.name ?? identityEmail)
  const email = displayEmail(user, identityEmail)
  const env = resolveEnv()
  const envLabel = env === 'production'
    ? t('userMenu.workspace.envProduction')
    : t('userMenu.workspace.envSandbox')
  const currentOrganization = currentSessionOrganization(identityContext)
  const role = currentOrganization?.role ?? 'viewer'
  const roleLabel = role === 'viewer' || role === 'editor' || role === 'admin'
    ? t(`userMenu.role.${role}`)
    : role
  const canOpenOperations = sessionCan(identityContext, 'recovery.read')
  const canManageCredentials = sessionCan(identityContext, 'credentials.write')
  const canManageBudget = sessionCan(identityContext, 'org.config.write')
  const canResumeOnboarding = sessionCan(identityContext, 'onboarding.write')

  const aiStatus = aiHealth?.enabled
    ? { pillKey: 'sidebar.aiMode.live', state: 'live' as const }
    : { pillKey: 'sidebar.aiMode.local', state: 'local' as const }
  const aiModel = aiHealth?.model ?? '—'
  const costGuardLabel = budgetGuardOn
    ? t('userMenu.ai.costGuard.on')
    : t('userMenu.ai.costGuard.off')

  const recentOrgs = useMemo(() => identityContext?.organizations.map(organization => ({
    ...organization,
    env,
    active: organization.id === identityContext.currentOrganizationId,
  })) ?? [], [env, identityContext])

  const commitWorkspace = async (nextContext: typeof identityContext, organizationId: string) => {
    if (!nextContext) return
    const { auth } = await AuthProvider.updateOrg(organizationId)
    setAuth(auth)
    setIdentityContext({
      ...nextContext,
      currentOrganizationId: organizationId,
      selectionRequired: false,
      needsOrganization: false,
    })
    setOpen(false)
  }

  const switchWorkspace = async (organizationId: string) => {
    if (!identityContext || organizationId === identityContext.currentOrganizationId) return
    setWorkspaceAction(`switch:${organizationId}`)
    try {
      await commitWorkspace(identityContext, organizationId)
    } catch (error) {
      addToast(tApiError(error) || t('auth.workspace.selectFailed'), 'error')
    } finally {
      setWorkspaceAction(null)
    }
  }

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault()
    if (workspaceName.trim().length < 2) return
    setWorkspaceAction('create')
    try {
      const next = await api('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: workspaceName }),
      }) as NonNullable<typeof identityContext>
      if (!next.currentOrganizationId) throw new Error(t('auth.workspace.createFailed'))
      await commitWorkspace(next, next.currentOrganizationId)
      setWorkspaceName('')
      setShowWorkspaceCreate(false)
    } catch (error) {
      addToast(tApiError(error) || t('auth.workspace.createFailed'), 'error')
    } finally {
      setWorkspaceAction(null)
    }
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    setWorkspaceAction('profile')
    try {
      const profile = await api('/users/me', {
        method: 'POST',
        body: JSON.stringify({ name: profileName || null }),
      }) as { name?: string | null; email?: string | null }
      if (identityContext) {
        setIdentityContext({
          ...identityContext,
          profile: {
            name: profile.name ?? null,
            email: profile.email ?? identityContext.profile.email,
          },
        })
      }
      setShowProfileEditor(false)
      addToast(t('userMenu.profile.saved'), 'success')
    } catch (error) {
      addToast(tApiError(error) || t('apiErrors.profile_update_failed'), 'error')
    } finally {
      setWorkspaceAction(null)
    }
  }

  const pickTheme = (next: ThemePreference) => {
    setTheme(next)
    setThemeState(next)
  }
  const pickDensity = (next: DensityPreference) => {
    setDensity(next)
    setDensityState(next)
  }

  const handleSignOut = async () => {
    try {
      await AuthProvider.signOut()
      clearAuth()
      addToast(t('toasts.signedOut'), 'info')
      setOpen(false)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
    }
  }

  const comingSoon = () => {
    addToast(t('userMenu.item.comingSoon'), 'info')
    setOpen(false)
  }

  // Bring back a skipped onboarding checklist — the only way back once the
  // operator dismissed the banner (the server reopens it via `resume`).
  const resumeOnboarding = async () => {
    setOpen(false)
    try {
      const next = (await api('/onboarding', {
        method: 'POST',
        body: JSON.stringify({ action: 'resume' }),
      })) as OnboardingState
      setOnboarding(next)
    } catch (err) {
      addToast(tApiError(err) || (t('userMenu.item.resumeOnboardingFailed')), 'error')
    }
  }

  const triggerLabel = open ? t('layout.closeMenu') : t('layout.openMenu')

  return (
    <div className="user-menu" ref={popoverRef}>
      <button
        type="button"
        className="user-menu__trigger"
        onClick={() => setOpen(prev => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
      >
        <span className="user-menu__trigger-avatar" aria-hidden="true">{initials(email)}</span>
        <span className="user-menu__trigger-name">{name}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="user-menu__popover"
          role="dialog"
          aria-modal="false"
          aria-label={t('userMenu.dialogLabel')}
        >
          {/* Identity strip */}
          <div className="user-menu__id">
            <span className="user-menu__id-avatar" aria-hidden="true">{initials(email)}</span>
            <div className="user-menu__id-body">
              <strong>{name}</strong>
              <span>{email}</span>
            </div>
            <span className="user-menu__id-role" aria-label={roleLabel}>
              {roleLabel}
            </span>
          </div>

          {/* Workspace */}
          <div className="user-menu__section">
            <span className="user-menu__section-label">{t('userMenu.workspace.heading')}</span>
          </div>
          <div className="user-menu__workspace">
            <span className="user-menu__workspace-ic" aria-hidden="true"><Building2 size={14} /></span>
            <div className="user-menu__workspace-body">
              <strong>{currentOrganization?.name ?? orgId ?? 'default'}</strong>
              <small>
                <span className={`user-menu__env user-menu__env--${env}`}>{envLabel}</span>
                <span className="user-menu__build">build {__BUILD_ID__}</span>
              </small>
            </div>
            {canOpenOperations && <button
              type="button"
              className="user-menu__workspace-pick"
              onClick={() => { onOpenTab?.('operations'); setOpen(false) }}
              title={t('userMenu.workspace.openSettings')}
              aria-label={t('userMenu.workspace.openSettings')}
            >
              <Settings2 size={14} aria-hidden="true" />
            </button>}
          </div>

          {/* Recent orgs */}
          {recentOrgs.length > 0 && (
            <div className="user-menu__recent">
              {recentOrgs.map(org => (
                <button
                  type="button"
                  key={org.id}
                  className={`user-menu__recent-row ${org.active ? 'user-menu__recent-row--on' : ''}`}
                  onClick={() => switchWorkspace(org.id)}
                  disabled={org.active || !org.usable || workspaceAction !== null}
                  aria-current={org.active ? 'true' : undefined}
                  aria-label={t(
                    org.active ? 'userMenu.recent.currentLabel' : 'userMenu.recent.switchLabel',
                    { name: org.name },
                  )}
                >
                  <span className={`user-menu__recent-dot user-menu__recent-dot--${org.env}`} aria-hidden="true" />
                  <span>{org.name}</span>
                  <span className="user-menu__recent-meta">
                    {workspaceAction === `switch:${org.id}` ? t('common.working') : org.role}
                  </span>
                </button>
              ))}
              {(identityContext?.identity.mode === 'supabase' || identityContext?.identity.mode === 'dev-headers') && (
                showWorkspaceCreate ? (
                  <form className="user-menu__recent-create" onSubmit={createWorkspace}>
                    <input
                      className="text-field"
                      aria-label={t('auth.workspace.organizationName')}
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                      minLength={2}
                      maxLength={80}
                      required
                      autoFocus
                    />
                    <button type="submit" disabled={workspaceAction !== null || workspaceName.trim().length < 2}>
                      {workspaceAction === 'create' ? t('common.working') : t('auth.workspace.createAction')}
                    </button>
                  </form>
                ) : (
                  <button type="button" className="user-menu__recent-add" onClick={() => setShowWorkspaceCreate(true)}>
                    <Plus size={11} aria-hidden="true" />
                    <span>{t('userMenu.recent.add')}</span>
                  </button>
                )
              )}
            </div>
          )}

          {/* AI operator */}
          <div className="user-menu__section user-menu__section--with-link">
            <span className="user-menu__section-label">{t('userMenu.ai.heading')}</span>
            {canOpenOperations && <a
              href="#"
              onClick={(event) => { event.preventDefault(); onOpenTab?.('operations'); setOpen(false) }}
            >
              {t('userMenu.ai.manage')}
            </a>}
          </div>
          <div className="user-menu__ai">
            <div className="user-menu__ai-top">
              <strong>
                <Sparkles size={13} aria-hidden="true" />
                <span>{t('userMenu.ai.subtitle')}</span>
              </strong>
              <span className={`user-menu__ai-pill user-menu__ai-pill--${aiStatus.state}`}>
                {t(aiStatus.pillKey)}
              </span>
            </div>
            <div className="user-menu__ai-meta">
              <span><b>{aiModel}</b></span>
              <span aria-hidden="true">·</span>
              <span>{costGuardLabel}</span>
            </div>
            {(canManageCredentials || canManageBudget) && <div className="user-menu__ai-actions">
              {canManageCredentials && <button type="button" onClick={() => { onOpenTab?.('credentials'); setOpen(false) }}>
                <KeyRound size={11} aria-hidden="true" />
                <span>{t('userMenu.ai.rotateKey')}</span>
              </button>}
              {canManageBudget && <button
                type="button"
                onClick={() => {
                  requestOperationsSection('ai')
                  onOpenTab?.('operations')
                  setOpen(false)
                }}
              >
                <DollarSign size={11} aria-hidden="true" />
                <span>{t('userMenu.ai.setBudget')}</span>
              </button>}
            </div>}
          </div>

          {/* Appearance */}
          <div className="user-menu__section">
            <span className="user-menu__section-label">{t('userMenu.appearance.heading')}</span>
          </div>
          <div className="user-menu__row">
            <span className="user-menu__row-label" title={t('userMenu.appearance.themeHint')}>{t('userMenu.appearance.themeLabel')}</span>
            <div className="user-menu__seg" role="radiogroup" aria-label={t('userMenu.appearance.themeLabel')}>
              <button
                type="button"
                role="radio"
                aria-checked={theme === 'system'}
                className={theme === 'system' ? 'user-menu__seg-on' : ''}
                onClick={() => pickTheme('system')}
              >
                <Monitor size={12} aria-hidden="true" />
                <span>{t('userMenu.appearance.theme.system')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={theme === 'light'}
                className={theme === 'light' ? 'user-menu__seg-on' : ''}
                onClick={() => pickTheme('light')}
              >
                <Sun size={12} aria-hidden="true" />
                <span>{t('userMenu.appearance.theme.light')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={theme === 'dark'}
                className={theme === 'dark' ? 'user-menu__seg-on' : ''}
                onClick={() => pickTheme('dark')}
              >
                <Moon size={12} aria-hidden="true" />
                <span>{t('userMenu.appearance.theme.dark')}</span>
              </button>
            </div>
          </div>
          <div className="user-menu__row">
            <span className="user-menu__row-label" title={t('userMenu.appearance.densityHint')}>{t('userMenu.appearance.densityLabel')}</span>
            <div className="user-menu__seg" role="radiogroup" aria-label={t('userMenu.appearance.densityLabel')}>
              <button
                type="button"
                role="radio"
                aria-checked={density === 'comfortable'}
                className={density === 'comfortable' ? 'user-menu__seg-on' : ''}
                onClick={() => pickDensity('comfortable')}
              >
                <span>{t('userMenu.appearance.density.comfortable')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={density === 'compact'}
                className={density === 'compact' ? 'user-menu__seg-on' : ''}
                onClick={() => pickDensity('compact')}
              >
                <span>{t('userMenu.appearance.density.compact')}</span>
              </button>
            </div>
          </div>

          <LocaleSwitcher variant="popover-row" />

          {showProfileEditor && (
            <form className="user-menu__profile-editor" onSubmit={saveProfile}>
              <label htmlFor="user-menu-profile-name">{t('auth.workspace.profileName')}</label>
              <input
                id="user-menu-profile-name"
                className="text-field"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                minLength={2}
                maxLength={100}
                autoComplete="name"
              />
              <div>
                <button type="button" onClick={() => setShowProfileEditor(false)}>{t('common.cancel')}</button>
                <button type="submit" disabled={workspaceAction !== null}>
                  {workspaceAction === 'profile' ? t('common.working') : t('userMenu.profile.save')}
                </button>
              </div>
            </form>
          )}

          {/* Items list */}
          <div className="user-menu__items">
            {onboarding?.status === 'skipped' && canResumeOnboarding && (
              <button type="button" className="user-menu__item" onClick={resumeOnboarding}>
                <span className="user-menu__item-ic" aria-hidden="true"><Sparkles size={12} /></span>
                <strong>{t('userMenu.item.resumeOnboarding')}</strong>
                <span></span>
              </button>
            )}
            <button type="button" className="user-menu__item" onClick={() => setShowProfileEditor((visible) => !visible)}>
              <span className="user-menu__item-ic" aria-hidden="true"><UserCog size={12} /></span>
              <strong>{t('userMenu.item.account')}</strong>
              <span></span>
            </button>
            {sessionCan(identityContext, 'members.read') && (
              <button type="button" className="user-menu__item" onClick={() => { onOpenTab?.('members'); setOpen(false) }}>
                <span className="user-menu__item-ic" aria-hidden="true"><Users size={12} /></span>
                <strong>{t('userMenu.item.team')}</strong>
                <span></span>
              </button>
            )}
            <button
              type="button"
              className="user-menu__item"
              onClick={() => { onOpenShortcuts?.(); setOpen(false); if (!onOpenShortcuts) comingSoon() }}
            >
              <span className="user-menu__item-ic" aria-hidden="true"><Keyboard size={12} /></span>
              <strong>{t('userMenu.item.shortcuts')}</strong>
              <span className="user-menu__item-kbd">?</span>
            </button>
            {safeDocsUrl && (
              <a
                className="user-menu__item"
                href={safeDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="user-menu-docs"
                onClick={() => setOpen(false)}
              >
                <span className="user-menu__item-ic" aria-hidden="true"><BookOpen size={12} /></span>
                <strong>{t('userMenu.item.docs')}</strong>
                <span></span>
              </a>
            )}
            {identityContext && identityContext.identity.mode !== 'dev-headers' && (
              <button type="button" className="user-menu__item user-menu__item--danger" onClick={handleSignOut}>
                <span className="user-menu__item-ic" aria-hidden="true"><LogOut size={12} /></span>
                <strong>{t('userMenu.item.signOut')}</strong>
                <span className="user-menu__item-kbd">⌃⇧Q</span>
              </button>
            )}
          </div>

          {/* Footer */}
          <div className="user-menu__footer">
            <span className="user-menu__footer-live">
              <span className="user-menu__footer-dot" />
              <span>{t('userMenu.footer.allNormal')}</span>
            </span>
            <button
              type="button"
              className="user-menu__footer-link"
              onClick={comingSoon}
              title={t('userMenu.footer.statusUnavailable')}
              aria-label={t('userMenu.footer.statusUnavailable')}
            >
              {t('userMenu.footer.status')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
