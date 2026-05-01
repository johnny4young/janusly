/**
 * User dropdown — shows the current user/org, lets the user switch org
 * (Supabase mode) or sign out. Closes on outside-click via a ref.
 *
 * Used by `App.tsx` (top-bar header).
 */

import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import { AuthProvider, isSupabaseConfigured } from '../auth'
import { useWorkflowStore } from '../store'

/** Render the user-info chip with org-switch + sign-out actions. */
export function UserMenu() {
  const user = useWorkflowStore(state => state.user)
  const userId = useWorkflowStore(state => state.userId)
  const orgId = useWorkflowStore(state => state.orgId)
  const setAuth = useWorkflowStore(state => state.setAuth)
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
      addToast('Signed out', 'info')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Sign out failed', 'error')
    }
  }

  const changeOrg = async () => {
    const trimmed = newOrg.trim()
    if (!trimmed) {
      addToast('Org id cannot be empty', 'error')
      return
    }
    try {
      const { auth } = await AuthProvider.updateOrg(trimmed)
      setAuth(auth)
      setOpen(false)
      addToast(`Switched to ${trimmed}`, 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Org switch failed', 'error')
    }
  }

  return (
    <div className="user-menu" ref={popoverRef}>
      <button
        onClick={() => setOpen(!open)}
        className="small-command user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="user-trigger-label">{user?.email ?? userId ?? 'dev-user'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="user-popover" role="menu">
          <label className="field-label" htmlFor="org-switcher">Org</label>
          <input
            id="org-switcher"
            className="text-field"
            value={newOrg}
            onChange={(event) => setNewOrg(event.target.value)}
          />
          <button className="small-command" onClick={changeOrg} type="button">Switch org</button>

          {isSupabaseConfigured && user && (
            <button className="small-command danger" onClick={logout} type="button">
              <LogOut size={14} aria-hidden="true" />
              <span>Logout</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
