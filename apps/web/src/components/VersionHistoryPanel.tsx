import React, { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'

type VersionRow = { id: string; version: number; dagJson: WorkflowDefinition; createdAt?: string }

export function VersionHistoryPanel() {
  const currentWorkflowId = useWorkflowStore(state => state.currentWorkflowId)
  const hydrateWorkflow = useWorkflowStore(state => state.hydrateWorkflow)
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [versions, setVersions] = useState<VersionRow[]>([])

  const load = useCallback(async () => {
    if (!currentWorkflowId) return
    try {
      const data = await api(`/workflows/versions?workflowId=${encodeURIComponent(currentWorkflowId)}`)
      setVersions(Array.isArray(data) ? (data as VersionRow[]) : [])
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Version history failed to load', 'error')
    }
  }, [addToast, currentWorkflowId])

  useEffect(() => { void load() }, [load, platformVersion])

  return (
    <div className="panel-card">
      <div className="section-kicker">
        <History size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
        Version History
      </div>

      {versions.length === 0 && <p className="empty-state">Save a workflow to start tracking versions.</p>}

      {versions.map((version) => (
        <button
          key={version.id}
          type="button"
          onClick={() => {
            hydrateWorkflow(version.dagJson)
            addToast(`Loaded v${version.version}`, 'success')
          }}
          className="version-button"
        >
          <span>v{version.version}</span>
          <span>{version.createdAt ? new Date(version.createdAt).toLocaleString() : ''}</span>
        </button>
      ))}
    </div>
  )
}
