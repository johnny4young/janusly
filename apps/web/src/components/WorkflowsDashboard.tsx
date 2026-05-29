/**
 * Saved-workflows list — calls `/workflows` and renders each as an
 * openable row. Re-fetches on `platformVersion` changes (cross-panel
 * reactivity hook from AGENTS.md).
 *
 * Used by `RightPanel.tsx` (the `workflows` tab).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleCheck, RefreshCw, Search, Workflow } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'
import { WorkflowHealthBadge } from './WorkflowHealthBadge'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'

/** Run statuses that count as "failed" for the failed-first sort (mirrors
 *  the server's terminal-failure set). */
const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled', 'timed_out'])

/** Render the saved-workflows list with click-to-open + manual refresh. */
export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recent' | 'name' | 'failed'>('recent')

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

  // Client-side filter + sort over the already-dense rows. `recent` keys on
  // the ISO updatedAt/createdAt (lexicographic desc == chronological desc);
  // `name` is locale-aware. No extra fetch — the list endpoint is the source.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? workflows.filter(w => w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q))
      : workflows
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, getResolvedLocale())
      if (sort === 'failed') {
        const af = a.lastRunStatus && FAILED_RUN_STATUSES.has(a.lastRunStatus) ? 0 : 1
        const bf = b.lastRunStatus && FAILED_RUN_STATUSES.has(b.lastRunStatus) ? 0 : 1
        if (af !== bf) return af - bf
      }
      return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')
    })
  }, [workflows, query, sort])

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

      {workflows.length > 1 && (
        <div className="we-list-toolbar">
          <span className="we-list-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="text-field"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('workflowsDashboard.searchPlaceholder') as string}
              aria-label={t('workflowsDashboard.searchPlaceholder') as string}
              data-testid="workflows-search"
            />
          </span>
          <div className="we-seg" role="group" aria-label={t('workflowsDashboard.sortAria') as string}>
            <button type="button" aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>
              {t('workflowsDashboard.sortRecent')}
            </button>
            <button type="button" aria-pressed={sort === 'name'} onClick={() => setSort('name')}>
              {t('workflowsDashboard.sortName')}
            </button>
            <button type="button" aria-pressed={sort === 'failed'} onClick={() => setSort('failed')}>
              {t('workflowsDashboard.sortFailed')}
            </button>
          </div>
        </div>
      )}

      {workflows.length === 0 && !loading && (
        <div className="we-allclear" data-testid="workflows-empty">
          <span className="we-allclear__ring" aria-hidden="true"><CircleCheck size={18} /></span>
          <div className="we-allclear__copy">
            <strong>{t('workflowsDashboard.empty')}</strong>
            <span>{t('workflowsDashboard.emptyHelper')}</span>
          </div>
        </div>
      )}

      {workflows.length > 0 && visible.length === 0 && (
        <p className="helper-text" data-testid="workflows-no-matches">{t('workflowsDashboard.noMatches')}</p>
      )}

      {visible.length > 0 && (
        <ul className="we-list">
          {visible.map(workflow => (
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
                  <small className="mono" title={workflow.id}>{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString(getResolvedLocale()) : workflow.id}</small>
                </div>
                <div className="we-list-row__meta">
                  {workflow.lastRunStatus && (
                    <span className="status-pill" data-status={workflow.lastRunStatus}>{formatStatusLabel(workflow.lastRunStatus)}</span>
                  )}
                  {typeof workflow.runCount === 'number' && (
                    <span className="we-list-row__count" title={t('workflowsDashboard.runCountTitle', { count: workflow.runCount }) as string}>{workflow.runCount}</span>
                  )}
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
