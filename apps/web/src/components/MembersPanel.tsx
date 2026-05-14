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

import React, { useCallback, useEffect, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole } from '../types'

type OrgRoleEntry = {
  name: string
  isBuiltin: boolean
  inheritsFrom: OrgRole
  description: string | null
}

const BUILTIN_ROLE_COPY: Record<OrgRole, string> = {
  viewer: 'View runs and saved flows',
  editor: 'Build, save, and run flows',
  admin: 'Manage team, tools, and connections',
}

function describeRole(role: string, entry?: OrgRoleEntry): string {
  if (entry && !entry.isBuiltin && entry.description) return entry.description
  if (role === 'viewer' || role === 'editor' || role === 'admin') {
    return BUILTIN_ROLE_COPY[role as OrgRole]
  }
  return entry ? `Custom role (inherits ${entry.inheritsFrom})` : 'Custom role'
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Render the members list with invite form + per-row role / remove controls. */
export function MembersPanel() {
  const addToast = useWorkflowStore(state => state.addToast)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [orgRoles, setOrgRoles] = useState<OrgRoleEntry[]>([
    { name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null },
    { name: 'editor', isBuiltin: true, inheritsFrom: 'editor', description: null },
    { name: 'admin', isBuiltin: true, inheritsFrom: 'admin', description: null },
  ])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('viewer')
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api('/members')
      setMembers(Array.isArray(data) ? data : [])
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Members failed to load', 'error')
    }
  }, [addToast])

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
      addToast('Enter a valid email address', 'error')
      return
    }

    setPending(true)
    try {
      await api('/members/invite', {
        method: 'POST',
        body: JSON.stringify({ email: trimmed, role }),
      })
      addToast(`Invited ${trimmed}`, 'success')
      setEmail('')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Invite failed', 'error')
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
      addToast('Role updated', 'success')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Update failed', 'error')
    }
  }

  const remove = async (userId: string) => {
    try {
      await api(`/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
      addToast('Member removed', 'success')
      bumpPlatformVersion()
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Remove failed', 'error')
    }
  }

  return (
    <div className="panel-list">
      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">Invite member</div>
            <strong>Add access by email</strong>
          </div>
          <span className="mode-pill mode-pill-neutral">{role}</span>
        </div>
        <label className="field-label" htmlFor="member-email">Email</label>
        <input
          id="member-email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="user@example.com"
          className="text-field"
          type="email"
          autoComplete="off"
        />
        <label className="field-label" htmlFor="member-role">Role</label>
        <select
          id="member-role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="text-field"
        >
          {orgRoles.map(option => (
            <option key={option.name} value={option.name}>
              {option.name}{option.isBuiltin ? '' : ' (custom)'}
            </option>
          ))}
        </select>
        <p className="helper-text">{describeRole(role, orgRoles.find(r => r.name === role))}</p>
        <button onClick={invite} className="command-button command-button-primary" disabled={pending}>
          <UserPlus size={15} aria-hidden="true" />
          <span>{pending ? 'Inviting…' : 'Invite'}</span>
        </button>
      </section>

      {members.length === 0 && (
        <div className="empty-panel">
          <UserPlus size={22} aria-hidden="true" />
          <strong>No members yet</strong>
          <p>Invite teammates by email and choose the smallest role they need.</p>
        </div>
      )}

      {members.map(member => (
        <div key={member.id} className="list-card member-row">
          <div>
            <strong>{member.email ?? member.userId}</strong>
            <span>{describeRole(member.role, orgRoles.find(r => r.name === member.role))}</span>
          </div>
          <div className="member-actions">
            <select
              className="text-field"
              value={member.role}
              onChange={(event) => updateRole(member.userId, event.target.value)}
              aria-label={`Role for ${member.email ?? member.userId}`}
            >
              {orgRoles.map(option => (
                <option key={option.name} value={option.name}>
                  {option.name}{option.isBuiltin ? '' : ' (custom)'}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="small-command danger"
              onClick={() => remove(member.userId)}
              aria-label={`Remove ${member.email ?? member.userId}`}
              title="Remove member"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
