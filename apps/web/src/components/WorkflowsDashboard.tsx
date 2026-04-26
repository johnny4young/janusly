import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'

export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api('/workflows')
      setWorkflows(Array.isArray(data) ? data : [])
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Workflows failed to load', 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  return (
    <div className="panel-list">
      <button onClick={load} className="small-command" disabled={loading} aria-label="Refresh saved workflows">
        <RefreshCw size={14} aria-hidden="true" /> {loading ? 'Loading…' : 'Refresh'}
      </button>

      {workflows.length === 0 && !loading && <p className="empty-state">No workflows saved yet. Build one and click Save.</p>}

      {workflows.map(workflow => (
        <div key={workflow.id} className="list-card">
          <strong>{workflow.name}</strong>
          <span>{workflow.id}</span>
          <button onClick={() => onOpen(workflow.id)} className="small-command">Open</button>
        </div>
      ))}
    </div>
  )
}
