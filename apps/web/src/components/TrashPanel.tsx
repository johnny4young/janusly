/**
 * Trash view for the Flows dashboard — the soft-deleted-workflows list shown
 * when the `WorkflowsDashboard` "Trash" toggle is on. A flat, filter-free,
 * Restore-only list (active-only affordances like folders/tags/bulk-move are
 * hidden here) with per-row + bulk Restore and a retention "expires in N days"
 * countdown.
 *
 * Presentation only: the container (`WorkflowsDashboard.tsx`) owns all data
 * fetching, selection state, and the restore mutations; this component receives
 * them as props.
 */

import type { Dispatch, SetStateAction } from 'react'
import { RotateCcw, Trash, Workflow } from 'lucide-react'
import type { SavedWorkflow } from '../types'
import { getResolvedLocale, useT } from '../i18n'
import { daysUntilPurge } from '../trash-expiry'

type TFunc = ReturnType<typeof useT>['t']

export type TrashPanelProps = {
  workflows: SavedWorkflow[]
  loading: boolean
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  toggleSelected: (workflowId: string) => void
  restoreWorkflow: (workflowId: string) => void | Promise<void>
  bulkRestore: () => void | Promise<void>
  retentionDays: number | null
  trashNowMs: number | null
  t: TFunc
}

export function TrashPanel({
  workflows,
  loading,
  selectedIds,
  setSelectedIds,
  toggleSelected,
  restoreWorkflow,
  bulkRestore,
  retentionDays,
  trashNowMs,
  t,
}: TrashPanelProps) {
  // A trash-list row: a flat, non-openable card (a tombstoned workflow can't be
  // opened — reads 404) showing the name, when it was deleted, its run count,
  // and a Restore action. A leading checkbox feeds the bulk-restore action bar
  // (always shown in Trash — selection is this view's purpose). No
  // tags/folder/drag — those are active-only.
  const renderTrashRow = (workflow: SavedWorkflow) => (
    <li key={workflow.id}>
      <div className="we-list-row" data-severity="cobalt" data-testid={`workflows-trash-row-${workflow.id}`}>
        <input
          type="checkbox"
          className="we-list-row__select"
          checked={selectedIds.has(workflow.id)}
          onChange={() => toggleSelected(workflow.id)}
          aria-label={t('workflowsDashboard.selectRowAria', { name: workflow.name })}
          data-testid={`workflows-trash-select-${workflow.id}`}
        />
        <span className="we-list-row__avatar" aria-hidden="true">
          <Workflow size={14} />
        </span>
        <div className="we-list-row__body">
          <strong>{workflow.name}</strong>
          <small className="mono" title={workflow.id}>
            {workflow.deletedAt
              ? (t('workflowsDashboard.deletedAtLabel', { date: new Date(workflow.deletedAt).toLocaleString(getResolvedLocale()) }))
              : workflow.id}
          </small>
        </div>
        <div className="we-list-row__meta">
          {typeof workflow.runCount === 'number' && (
            <span className="we-list-row__count" title={t('workflowsDashboard.runCountTitle', { count: workflow.runCount })}>{workflow.runCount}</span>
          )}
          {/* Retention countdown — only when the window is known (retentionDays
              non-null) and the row carries a tombstone date. A non-positive
              remaining count means the window elapsed (the daily sweep is due). */}
          {retentionDays != null && trashNowMs != null && workflow.deletedAt && (() => {
            const daysLeft = daysUntilPurge(workflow.deletedAt, retentionDays, trashNowMs)
            return (
              <span className="we-pill" data-tone="ghost" data-testid={`workflows-trash-expiry-${workflow.id}`}>
                {daysLeft > 0
                  ? (t('workflowsDashboard.expiresInDays', { count: daysLeft }))
                  : (t('workflowsDashboard.expiresSoon'))}
              </span>
            )
          })()}
          <button
            type="button"
            className="small-command"
            onClick={() => void restoreWorkflow(workflow.id)}
            data-testid={`workflows-restore-${workflow.id}`}
          >
            <RotateCcw size={14} aria-hidden="true" /> {t('workflowsDashboard.restoreFlow')}
          </button>
        </div>
      </div>
    </li>
  )

  // Trash view — a flat, filter-free list of soft-deleted workflows (uses
  // the raw server-ordered `workflows`, NOT `visible`, so a stale active-
  // view search term never filters it). Restore-only; no folders/tags/bulk.
  return workflows.length === 0 && !loading ? (
    <div className="we-allclear" data-testid="workflows-trash-empty">
      <span className="we-allclear__ring" aria-hidden="true"><Trash size={18} /></span>
      <div className="we-allclear__copy">
        <strong>{t('workflowsDashboard.trashEmpty')}</strong>
        <span>{t('workflowsDashboard.trashEmptyHelper')}</span>
      </div>
    </div>
  ) : workflows.length > 0 ? (
    <>
      {/* Bulk-restore action bar — selection is always available in Trash.
          Select-all operates on the raw trash `workflows` (the rendered
          set). Restore-selected is disabled until ≥1 row is ticked. */}
      <div className="we-list-bulk-bar" data-testid="workflows-trash-actions">
        {selectedIds.size > 0 && (
          <span className="we-list-bulk-bar__count">{t('workflowsDashboard.bulkSelectedCount', { count: selectedIds.size })}</span>
        )}
        <button
          type="button"
          className="small-command"
          aria-pressed={workflows.every((w) => selectedIds.has(w.id))}
          onClick={() => setSelectedIds(workflows.every((w) => selectedIds.has(w.id)) ? new Set() : new Set(workflows.map((w) => w.id)))}
          data-testid="workflows-trash-select-all"
        >
          {workflows.every((w) => selectedIds.has(w.id))
            ? t('workflowsDashboard.clearSelection')
            : t('workflowsDashboard.trashSelectAll', { count: workflows.length })}
        </button>
        <button
          type="button"
          className="small-command"
          disabled={selectedIds.size === 0}
          onClick={() => void bulkRestore()}
          data-testid="workflows-trash-restore-selected"
        >
          <RotateCcw size={14} aria-hidden="true" /> {t('workflowsDashboard.trashRestoreSelected', { count: selectedIds.size })}
        </button>
      </div>
      <ul className="we-list" data-testid="workflows-trash-list">
        {workflows.map(renderTrashRow)}
      </ul>
    </>
  ) : null
}
