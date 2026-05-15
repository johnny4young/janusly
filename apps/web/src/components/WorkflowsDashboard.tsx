/**
 * Saved-workflows list — calls `/workflows` and renders each as an
 * openable row. Re-fetches on `platformVersion` changes (cross-panel
 * reactivity hook from AGENTS.md).
 *
 * Used by `RightPanel.tsx` (the `workflows` tab).
 */

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'
import { WorkflowHealthBadge } from './WorkflowHealthBadge'
import { getResolvedLocale, useT } from '../i18n'

/** Render the saved-workflows list with click-to-open + manual refresh. */
export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT()
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
      addToast(error instanceof Error ? error.message : t('workflowsDashboard.toastFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast, t])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  return (
    <div className="panel-list">
      <div className="panel-toolbar">
        <div>
          <strong>{t('workflowsDashboard.savedFlows', { count: workflows.length })}</strong>
          <p className="helper-text">{t('workflowsDashboard.helper')}</p>
        </div>
        <button onClick={load} className="small-command" disabled={loading} aria-label={t('workflowsDashboard.refresh')}>
          <RefreshCw size={14} aria-hidden="true" /> {loading ? t('workflowsDashboard.loading') : t('workflowsDashboard.refresh')}
        </button>
      </div>

      {workflows.length === 0 && !loading && (
        <div className="empty-panel">
          <RefreshCw size={22} aria-hidden="true" />
          <strong>{t('workflowsDashboard.empty')}</strong>
          <p>{t('workflowsDashboard.emptyHelper')}</p>
        </div>
      )}

      {workflows.map(workflow => (
        <div key={workflow.id} className="list-card workflow-row">
          <div>
            <strong>{workflow.name}</strong>
            <span>{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString(getResolvedLocale()) : workflow.id}</span>
          </div>
          <div className="workflow-row-actions">
            <WorkflowHealthBadge workflowId={workflow.id} showLabel={false} />
            <button onClick={() => onOpen(workflow.id)} className="small-command">{t('workflowsDashboard.openFlow')}</button>
          </div>
        </div>
      ))}
    </div>
  )
}
