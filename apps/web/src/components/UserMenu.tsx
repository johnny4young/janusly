/**
 * User dropdown — shows the current user/org, lets the user switch org
 * (Supabase mode), pick a UI language, or sign out. Closes on outside-click
 * via a ref.
 *
 * Used by `App.tsx` (top-bar header).
 */

import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import { AuthProvider, isSupabaseConfigured } from '../auth'
import { useWorkflowStore } from '../store'
import { LocaleSwitcher } from '../i18n/LocaleSwitcher'
import { useT } from '../i18n'

/** Render the user-info chip with org-switch + locale-switch + sign-out actions. */
export function UserMenu() {
  const { t } = useT()
  const user = useWorkflowStore(state => state.user)
  const userId = useWorkflowStore(state => state.userId)
  const orgId = useWorkflowStore(state => state.orgId)
  const setAuth = useWorkflowStore(state => state.setAuth)
  const clearAuth = useWorkflowStore(state => state.clearAuth)
  const addToast = useWorkflowStore(state => state.addToast)

  const [open, setOpen] = useState(false)
  const [newOrg, setNewOrg] = useState(orgId ?? '')
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setNewOrg(orgId ?? '')
  }, [orgId])

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const logout = async () => {
    try {
      await AuthProvider.signOut()
      clearAuth()
      addToast(t('toasts.signedOut'), 'info')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
    }
  }

  const changeOrg = async () => {
    const trimmed = newOrg.trim()
    if (!trimmed) {
      addToast(t('toasts.orgRequired'), 'error')
      return
    }
    try {
      const { auth } = await AuthProvider.updateOrg(trimmed)
      setAuth(auth)
      setOpen(false)
      addToast(t('toasts.orgSwitched', { org: trimmed }), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.orgSwitchFailed'), 'error')
    }
  }

  return (
    <div className="user-menu" ref={popoverRef}>
      <button
        onClick={() => setOpen(!open)}
        className="small-command user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={open ? t('layout.closeMenu') : t('layout.openMenu')}
      >
        <span className="user-trigger-label">{user?.email ?? userId ?? 'dev-user'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="user-popover" role="menu">
          <label className="field-label" htmlFor="org-switcher">{t('auth.userMenu.org')}</label>
          <input
            id="org-switcher"
            className="text-field"
            value={newOrg}
            onChange={(event) => setNewOrg(event.target.value)}
          />
          <button className="small-command" onClick={changeOrg} type="button">{t('auth.userMenu.switchOrg')}</button>

          <LocaleSwitcher variant="popover-row" />

          {isSupabaseConfigured && (user || userId) && (
            <button className="small-command danger" onClick={logout} type="button">
              <LogOut size={14} aria-hidden="true" />
              <span>{t('auth.userMenu.logout')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
