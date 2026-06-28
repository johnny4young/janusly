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

import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { AuthProvider, isSupabaseConfigured } from '../auth'
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

const BUILD_PLACEHOLDER = '2026.05.14-90f3a77'
type UserMenuProps = {
  aiHealth?: AiHealth | null
  budgetGuardOn?: boolean | null
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

export function UserMenu({ aiHealth = null, budgetGuardOn = null, onOpenTab, onOpenShortcuts }: UserMenuProps) {
  const { t } = useT()
  const user = useWorkflowStore(state => state.user)
  const userId = useWorkflowStore(state => state.userId)
  const orgId = useWorkflowStore(state => state.orgId)
  const clearAuth = useWorkflowStore(state => state.clearAuth)
  const addToast = useWorkflowStore(state => state.addToast)
  const onboarding = useWorkflowStore(state => state.onboarding)
  const setOnboarding = useWorkflowStore(state => state.setOnboarding)

  const [open, setOpen] = useState(false)
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredTheme())
  const [density, setDensityState] = useState<DensityPreference>(() => getStoredDensity())
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const name = displayName(user, userId ?? 'dev-user')
  const email = displayEmail(user, userId ?? 'dev-user@local')
  const env = resolveEnv()
  const envLabel = env === 'production'
    ? t('userMenu.workspace.envProduction')
    : t('userMenu.workspace.envSandbox')
  const role = 'editor'

  const aiStatus = aiHealth?.enabled
    ? { pillKey: 'sidebar.aiMode.live', state: 'live' as const }
    : { pillKey: 'sidebar.aiMode.local', state: 'local' as const }
  const aiModel = aiHealth?.model ?? '—'
  const costGuardLabel = budgetGuardOn
    ? t('userMenu.ai.costGuard.on')
    : t('userMenu.ai.costGuard.off')

  const recentOrgs = useMemo(() => {
    if (!orgId) return []
    return [{ id: orgId, env, active: true }]
  }, [orgId, env])

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
      addToast(tApiError(err) || (t('userMenu.item.resumeOnboardingFailed') as string), 'error')
    }
  }

  const triggerLabel = open ? t('layout.closeMenu') : t('layout.openMenu')

  return (
    <div className="user-menu" ref={popoverRef}>
      <button
        type="button"
        className="user-menu__trigger"
        onClick={() => setOpen(prev => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
      >
        <span className="user-menu__trigger-avatar" aria-hidden="true">{initials(email)}</span>
        <span className="user-menu__trigger-name">{user?.email ?? userId ?? 'dev-user'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div className="user-menu__popover" role="menu">
          {/* Identity strip */}
          <div className="user-menu__id">
            <span className="user-menu__id-avatar" aria-hidden="true">{initials(email)}</span>
            <div className="user-menu__id-body">
              <strong>{name}</strong>
              <span>{email}</span>
            </div>
            <span className="user-menu__id-role" aria-label={t(`userMenu.role.${role}` as never) as string}>
              {t(`userMenu.role.${role}` as never)}
            </span>
          </div>

          {/* Workspace */}
          <div className="user-menu__section">
            <span className="user-menu__section-label">{t('userMenu.workspace.heading')}</span>
          </div>
          <div className="user-menu__workspace">
            <span className="user-menu__workspace-ic" aria-hidden="true"><Building2 size={14} /></span>
            <div className="user-menu__workspace-body">
              <strong>{orgId ?? 'default'}</strong>
              <small>
                <span className={`user-menu__env user-menu__env--${env}`}>{envLabel}</span>
                <span className="user-menu__build">build {BUILD_PLACEHOLDER}</span>
              </small>
            </div>
            <button
              type="button"
              className="user-menu__workspace-pick"
              onClick={() => { onOpenTab?.('operations'); setOpen(false) }}
              title={t('userMenu.workspace.openSettings')}
              aria-label={t('userMenu.workspace.openSettings')}
            >
              <Settings2 size={14} aria-hidden="true" />
            </button>
          </div>

          {/* Recent orgs */}
          {recentOrgs.length > 0 && (
            <div className="user-menu__recent">
              {recentOrgs.map(org => (
                <div key={org.id} className={`user-menu__recent-row ${org.active ? 'user-menu__recent-row--on' : ''}`}>
                  <span className={`user-menu__recent-dot user-menu__recent-dot--${org.env}`} aria-hidden="true" />
                  <span>{org.id}</span>
                  <span className="user-menu__recent-meta">⌘1</span>
                </div>
              ))}
              <button type="button" className="user-menu__recent-add" onClick={comingSoon}>
                <Plus size={11} aria-hidden="true" />
                <span>{t('userMenu.recent.add')}</span>
              </button>
            </div>
          )}

          {/* AI operator */}
          <div className="user-menu__section user-menu__section--with-link">
            <span className="user-menu__section-label">{t('userMenu.ai.heading')}</span>
            <a
              href="#"
              onClick={(event) => { event.preventDefault(); onOpenTab?.('operations'); setOpen(false) }}
            >
              {t('userMenu.ai.manage')}
            </a>
          </div>
          <div className="user-menu__ai">
            <div className="user-menu__ai-top">
              <strong>
                <Sparkles size={13} aria-hidden="true" />
                <span>{t('userMenu.ai.subtitle')}</span>
              </strong>
              <span className={`user-menu__ai-pill user-menu__ai-pill--${aiStatus.state}`}>
                {t(aiStatus.pillKey as never)}
              </span>
            </div>
            <div className="user-menu__ai-meta">
              <span><b>{aiModel}</b></span>
              <span aria-hidden="true">·</span>
              <span>{costGuardLabel}</span>
            </div>
            <div className="user-menu__ai-actions">
              <button type="button" onClick={() => { onOpenTab?.('credentials'); setOpen(false) }}>
                <KeyRound size={11} aria-hidden="true" />
                <span>{t('userMenu.ai.rotateKey')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  requestOperationsSection('reliability')
                  onOpenTab?.('operations')
                  setOpen(false)
                }}
              >
                <DollarSign size={11} aria-hidden="true" />
                <span>{t('userMenu.ai.setBudget')}</span>
              </button>
            </div>
          </div>

          {/* Appearance */}
          <div className="user-menu__section">
            <span className="user-menu__section-label">{t('userMenu.appearance.heading')}</span>
          </div>
          <div className="user-menu__row">
            <span className="user-menu__row-label" title={t('userMenu.appearance.themeHint') as string}>{t('userMenu.appearance.themeLabel')}</span>
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
            <span className="user-menu__row-label" title={t('userMenu.appearance.densityHint') as string}>{t('userMenu.appearance.densityLabel')}</span>
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

          {/* Items list */}
          <div className="user-menu__items">
            {onboarding?.status === 'skipped' && (
              <button type="button" className="user-menu__item" onClick={resumeOnboarding}>
                <span className="user-menu__item-ic" aria-hidden="true"><Sparkles size={12} /></span>
                <strong>{t('userMenu.item.resumeOnboarding')}</strong>
                <span></span>
              </button>
            )}
            <button type="button" className="user-menu__item" onClick={comingSoon}>
              <span className="user-menu__item-ic" aria-hidden="true"><UserCog size={12} /></span>
              <strong>{t('userMenu.item.account')}</strong>
              <span></span>
            </button>
            <button type="button" className="user-menu__item" onClick={() => { onOpenTab?.('members'); setOpen(false) }}>
              <span className="user-menu__item-ic" aria-hidden="true"><Users size={12} /></span>
              <strong>{t('userMenu.item.team')}</strong>
              <span></span>
            </button>
            <button type="button" className="user-menu__item" onClick={comingSoon}>
              <span className="user-menu__item-ic" aria-hidden="true"><KeyRound size={12} /></span>
              <strong>{t('userMenu.item.tokens')}</strong>
              <span></span>
            </button>
            <button
              type="button"
              className="user-menu__item"
              onClick={() => { onOpenShortcuts?.(); setOpen(false); if (!onOpenShortcuts) comingSoon() }}
            >
              <span className="user-menu__item-ic" aria-hidden="true"><Keyboard size={12} /></span>
              <strong>{t('userMenu.item.shortcuts')}</strong>
              <span className="user-menu__item-kbd">?</span>
            </button>
            <button
              type="button"
              className="user-menu__item"
              onClick={comingSoon}
              title={t('userMenu.item.docsUnavailable')}
              aria-label={t('userMenu.item.docsUnavailable')}
            >
              <span className="user-menu__item-ic" aria-hidden="true"><BookOpen size={12} /></span>
              <strong>{t('userMenu.item.docs')}</strong>
              <span></span>
            </button>
            {isSupabaseConfigured && (user || userId) && (
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
