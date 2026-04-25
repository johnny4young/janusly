import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { SavedWorkflow } from '../types'

export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    const data = await api('/workflows')
    setWorkflows(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div style={{ padding: 12 }}>
      <h2>Workflows</h2>
      <button onClick={load}>Refresh</button>

      {loading && <p>Loading...</p>}

      {workflows.map(w => (
        <div key={w.id} style={{ background: 'white', border: '1px solid #ddd', marginTop: 8, padding: 10, borderRadius: 8 }}>
          <strong>{w.name}</strong>
          <div style={{ fontSize: 12, color: '#666' }}>{w.id}</div>
          <button onClick={() => onOpen(w.id)} style={{ marginTop: 6 }}>Open</button>
        </div>
      ))}
    </div>
  )
}
