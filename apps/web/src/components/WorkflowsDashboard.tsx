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
      <div className="panel-toolbar">
        <div>
          <strong>{workflows.length} saved flows</strong>
          <p className="helper-text">The list updates after Save or Run refreshes workspace data.</p>
        </div>
        <button onClick={load} className="small-command" disabled={loading} aria-label="Refresh">
          <RefreshCw size={14} aria-hidden="true" /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {workflows.length === 0 && !loading && (
        <div className="empty-panel">
          <RefreshCw size={22} aria-hidden="true" />
          <strong>No flows saved yet</strong>
          <p>Build a flow on the canvas, validate it, then click Save.</p>
        </div>
      )}

      {workflows.map(workflow => (
        <div key={workflow.id} className="list-card workflow-row">
          <div>
            <strong>{workflow.name}</strong>
            <span>{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString() : workflow.id}</span>
          </div>
          <button onClick={() => onOpen(workflow.id)} className="small-command">Open flow</button>
        </div>
      ))}
    </div>
  )
}
