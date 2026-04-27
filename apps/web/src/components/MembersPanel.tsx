import React, { useCallback, useEffect, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole } from '../types'

const roles: OrgRole[] = ['viewer', 'editor', 'admin']
const roleCopy: Record<OrgRole, string> = {
  viewer: 'View runs and saved flows',
  editor: 'Build, save, and run flows',
  admin: 'Manage team, tools, and connections',
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function MembersPanel() {
  const addToast = useWorkflowStore(state => state.addToast)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('viewer')
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
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Invite failed', 'error')
    } finally {
      setPending(false)
    }
  }

  const updateRole = async (userId: string, nextRole: OrgRole) => {
    try {
      await api('/members/role', {
        method: 'POST',
        body: JSON.stringify({ userId, role: nextRole }),
      })
      addToast('Role updated', 'success')
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Update failed', 'error')
    }
  }

  const remove = async (userId: string) => {
    try {
      await api(`/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
      addToast('Member removed', 'success')
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
          onChange={(event) => setRole(event.target.value as OrgRole)}
          className="text-field"
        >
          {roles.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <p className="helper-text">{roleCopy[role]}</p>
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
            <span>{roleCopy[member.role]}</span>
          </div>
          <div className="member-actions">
            <select
              className="text-field"
              value={member.role}
              onChange={(event) => updateRole(member.userId, event.target.value as OrgRole)}
              aria-label={`Role for ${member.email ?? member.userId}`}
            >
              {roles.map(option => <option key={option} value={option}>{option}</option>)}
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
