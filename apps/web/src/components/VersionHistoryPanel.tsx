import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useWorkflowStore } from '../store'

export function VersionHistoryPanel() {
  const { currentWorkflowId, hydrateWorkflow, addToast } = useWorkflowStore()
  const [versions, setVersions] = useState<any[]>([])

  useEffect(() => {
    if (!currentWorkflowId) return
    api(`/workflows/versions?workflowId=${currentWorkflowId}`).then(setVersions)
  }, [currentWorkflowId])

  return (
    <div className="space-y-2 p-4">
      <h3 className="text-sm font-semibold text-slate-700">Version history</h3>

      {versions.map((v) => (
        <button
          key={v.id}
          onClick={() => {
            hydrateWorkflow(v.dagJson)
            addToast(`Loaded v${v.version}`, 'success')
          }}
          className="flex w-full items-center justify-between rounded-lg border bg-white px-3 py-2 text-left text-sm shadow-sm hover:bg-slate-50"
        >
          <span>v{v.version}</span>
          <span className="text-xs text-slate-400">{new Date(v.createdAt).toLocaleString()}</span>
        </button>
      ))}
    </div>
  )
}
