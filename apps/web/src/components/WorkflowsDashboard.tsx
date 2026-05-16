/**
 * Saved-workflows list — calls `/workflows` and renders each as an
 * openable row. Re-fetches on `platformVersion` changes (cross-panel
 * reactivity hook from AGENTS.md).
 *
 * Used by `RightPanel.tsx` (the `workflows` tab).
 */

import React, { useCallback, useEffect, useState } from 'react'
import { CircleCheck, RefreshCw, Workflow } from 'lucide-react'
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
        <div className="we-allclear" data-testid="workflows-empty">
          <span className="we-allclear__ring" aria-hidden="true"><CircleCheck size={18} /></span>
          <div className="we-allclear__copy">
            <strong>{t('workflowsDashboard.empty')}</strong>
            <span>{t('workflowsDashboard.emptyHelper')}</span>
          </div>
        </div>
      )}

      {workflows.length > 0 && (
        <ul className="we-list">
          {workflows.map(workflow => (
            <li key={workflow.id}>
              <div
                className="we-list-row"
                data-clickable="true"
                data-severity="cobalt"
                data-testid={`workflows-row-${workflow.id}`}
                onClick={() => onOpen(workflow.id)}
              >
                <span className="we-list-row__avatar" aria-hidden="true">
                  <Workflow size={14} />
                </span>
                <div className="we-list-row__body">
                  <strong>{workflow.name}</strong>
                  <small>{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString(getResolvedLocale()) : workflow.id}</small>
                </div>
                <div className="we-list-row__meta">
                  <WorkflowHealthBadge workflowId={workflow.id} showLabel={false} />
                  <button onClick={(event) => { event.stopPropagation(); onOpen(workflow.id) }} className="small-command">{t('workflowsDashboard.openFlow')}</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
