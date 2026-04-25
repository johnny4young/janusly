import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole } from '../types'

const roles: OrgRole[] = ['viewer', 'editor', 'admin']

export function MembersPanel() {
  const { addToast } = useWorkflowStore()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('viewer')

  const load = async () => {
    const data = await api('/members')
    setMembers(data ?? [])
  }

  useEffect(() => { load() }, [])

  const invite = async () => {
    try {
      await api('/members/invite', {
        method: 'POST',
        body: JSON.stringify({ email, role, userId: email })
      })
      addToast('User invited', 'success')
      setEmail('')
      load()
    } catch {
      addToast('Invite failed', 'error')
    }
  }

  const updateRole = async (userId: string, role: OrgRole) => {
    try {
      await api('/members/role', {
        method: 'POST',
        body: JSON.stringify({ userId, role })
      })
      addToast('Role updated', 'success')
      load()
    } catch {
      addToast('Update failed', 'error')
    }
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="font-semibold">Members</h2>

      <div className="flex gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" className="border px-2 py-1 rounded w-full" />
        <select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="border rounded px-2">
          {roles.map(r => <option key={r}>{r}</option>)}
        </select>
        <button onClick={invite} className="bg-black text-white px-3 rounded">Invite</button>
      </div>

      {members.map(m => (
        <div key={m.id} className="flex justify-between items-center border p-2 rounded">
          <div>
            <div>{m.email}</div>
            <div className="text-xs text-slate-400">{m.userId}</div>
          </div>
          <select value={m.role} onChange={(e) => updateRole(m.userId, e.target.value as OrgRole)}>
            {roles.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}
