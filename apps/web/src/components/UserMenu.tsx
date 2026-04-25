import React, { useState } from 'react'
import { AuthProvider } from '../auth'
import { useWorkflowStore } from '../store'

export function UserMenu() {
  const { user, orgId, setAuth } = useWorkflowStore()
  const [open, setOpen] = useState(false)
  const [newOrg, setNewOrg] = useState(orgId ?? '')

  if (!user) return null

  const logout = async () => {
    await AuthProvider.signOut()
  }

  const changeOrg = async () => {
    const { auth } = await AuthProvider.updateOrg(newOrg)
    setAuth(auth)
    setOpen(false)
  }

  return (
    <div style={{ position: 'absolute', top: 10, right: 10 }}>
      <button onClick={() => setOpen(!open)}>
        {user.email}
      </button>

      {open && (
        <div style={{ background: 'white', padding: 10, border: '1px solid #ccc' }}>
          <div>
            <strong>Org:</strong>
            <input value={newOrg} onChange={(e) => setNewOrg(e.target.value)} />
            <button onClick={changeOrg}>switch</button>
          </div>

          <button onClick={logout}>Logout</button>
        </div>
      )}
    </div>
  )
}
