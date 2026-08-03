/**
 * A single workflow row in the active Flows list (name, tag pills, folder pill,
 * last-run status, paused pill + breaker Resume, health badge, per-row
 * folder/tag controls, the inline-confirm Delete, and the open affordance). Rendered by `WorkflowsDashboard.tsx` in both
 * the flat and folder-grouped views.
 *
 * Presentation only: the container owns all state (drag, selection, delete
 * confirm) and the folder/tag/delete mutations; this component receives them as
 * props.
 */

import { memo, type Dispatch, type SetStateAction } from 'react'
import { Folder, GripVertical, PlayCircle, Trash2, Workflow, X } from 'lucide-react'
import type { SavedWorkflow } from '../types'
import { WorkflowHealthBadge } from './WorkflowHealthBadge'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'

type TFunc = ReturnType<typeof useT>['t']

export type FlowRowProps = {
  workflow: SavedWorkflow
  canWrite: boolean
  folderOptions: string[]
  tagOptions: string[]
  hasFolders: boolean
  selectionMode: boolean
  selectedIds: Set<string>
  draggingId: string | null
  confirmDeleteId: string | null
  onOpen: (id: string) => void
  toggleSelected: (workflowId: string) => void
  setDraggingId: Dispatch<SetStateAction<string | null>>
  setDropTarget: Dispatch<SetStateAction<string | null>>
  setConfirmDeleteId: Dispatch<SetStateAction<string | null>>
  setRowTag: (workflowId: string, tag: string, op: 'add' | 'remove') => void | Promise<void>
  moveToFolder: (workflowId: string, folderKey: string) => void | Promise<void>
  deleteWorkflow: (workflowId: string) => void | Promise<void>
  resumeWorkflow: (workflowId: string) => void | Promise<void>
  recoveryBusy: boolean
  t: TFunc
}

/** `workflows.status` for a workflow its circuit breaker paused. */
const STATUS_PAUSED_CIRCUIT_BREAKER = 'paused_circuit_breaker'

export const FlowRow = memo(function FlowRow({
  workflow,
  canWrite,
  folderOptions,
  tagOptions,
  hasFolders,
  selectionMode,
  selectedIds,
  draggingId,
  confirmDeleteId,
  onOpen,
  toggleSelected,
  setDraggingId,
  setDropTarget,
  setConfirmDeleteId,
  setRowTag,
  moveToFolder,
  deleteWorkflow,
  resumeWorkflow,
  recoveryBusy,
  t,
}: FlowRowProps) {
  // `status` is absent on older cached rows; treat that as active.
  const pausedByBreaker = workflow.status === STATUS_PAUSED_CIRCUIT_BREAKER
  const isPaused = Boolean(workflow.status) && workflow.status !== 'active'
  const hasBufferedTriggers = (workflow.bufferedTriggerCount ?? 0) > 0
  // Folder choices for the per-row "Move to folder" select: the org-wide
  // folder list plus the row's own folder if a stale value isn't already in it
  // (so the native select can always render its current value as a real option).
  const folderChoices =
    workflow.folder && !folderOptions.includes(workflow.folder)
      ? [workflow.folder, ...folderOptions]
      : folderOptions
  // Org tags not already on this row — the per-row "+ tag" add options.
  const rowTags = workflow.tags ?? []
  const addableTags = tagOptions.filter((tg) => !rowTags.includes(tg))
  return (
    <li>
      <div
        className="we-list-row"
        data-clickable="true"
        data-severity="cobalt"
        data-dragging={draggingId === workflow.id ? 'true' : undefined}
        data-testid={`workflows-row-${workflow.id}`}
        onClick={() => onOpen(workflow.id)}
      >
        {/* Bulk-select checkbox — only in selection mode. stopPropagation so
            ticking a row never opens it. */}
        {canWrite && selectionMode && (
          <input
            type="checkbox"
            className="we-list-row__select"
            checked={selectedIds.has(workflow.id)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => { event.stopPropagation(); toggleSelected(workflow.id) }}
            aria-label={t('workflowsDashboard.selectRowAria', { name: workflow.name })}
            data-testid={`workflows-select-row-${workflow.id}`}
          />
        )}
        {/* Drag handle — only rendered once folders exist (otherwise there's no
            section to drop onto). Native DnD is mouse-only; the per-row select
            below and the Inspector folder field stay keyboard-accessible. */}
        {canWrite && hasFolders && (
          <span
            className="we-list-row__drag"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', workflow.id)
              event.dataTransfer.effectAllowed = 'move'
              setDraggingId(workflow.id)
            }}
            onDragEnd={() => {
              setDraggingId(null)
              setDropTarget(null)
            }}
            onClick={(event) => event.stopPropagation()}
            title={t('workflowsDashboard.dragHandleTitle')}
            aria-label={t('workflowsDashboard.dragHandleTitle')}
            data-testid={`workflows-drag-${workflow.id}`}
          >
            <GripVertical size={14} aria-hidden="true" />
          </span>
        )}
        <span className="we-list-row__avatar" aria-hidden="true">
          <Workflow size={14} />
        </span>
        <div className="we-list-row__body">
          <strong>{workflow.name}</strong>
          <small className="mono" title={workflow.id}>{workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleString(getResolvedLocale()) : workflow.id}</small>
          {/* Tag pills are editable inline: each carries a ✕ to remove it, and a
              "+ tag" picker adds an existing org tag — the per-row equivalent of
              the bulk tag bar. Controls stopPropagation so they never open the row. */}
          {(rowTags.length > 0 || addableTags.length > 0) && (
            <span className="we-list-row__tags">
              {rowTags.map(tag => (
                <span key={tag} className="we-pill we-list-row__tag" data-tone="ghost">
                  {tag}
                  {canWrite && (
                    <button
                      type="button"
                      className="we-list-row__tag-remove"
                      aria-label={t('workflowsDashboard.removeTagAria', { tag })}
                      title={t('workflowsDashboard.removeTagAria', { tag })}
                      onClick={(event) => { event.stopPropagation(); void setRowTag(workflow.id, tag, 'remove') }}
                      data-testid={`workflows-row-tag-remove-${workflow.id}-${tag}`}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}
              {canWrite && addableTags.length > 0 && (
                <select
                  className="we-list-row__tag-add"
                  value=""
                  aria-label={t('workflowsDashboard.addTagAria', { name: workflow.name })}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => { event.stopPropagation(); if (event.target.value) void setRowTag(workflow.id, event.target.value, 'add') }}
                  data-testid={`workflows-row-tag-add-${workflow.id}`}
                >
                  <option value="">{t('workflowsDashboard.addTagPlaceholder')}</option>
                  {addableTags.map(tag => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </select>
              )}
            </span>
          )}
          {workflow.folder && (
            <span className="we-list-row__folder">
              <span className="we-pill" data-tone="ghost" title={t('workflowsDashboard.inFolder', { folder: workflow.folder })}>
                <Folder size={12} aria-hidden="true" /> {workflow.folder}
              </span>
            </span>
          )}
        </div>
        <div className="we-list-row__meta">
          {/* A paused workflow refuses new runs, so the list says so before the
              operator clicks Run and gets a 409. The reason carries the
              evidence (which is why it's the tooltip, not a truncated pill). */}
          {isPaused && (
            <span className="status-pill" data-status="paused" title={workflow.pausedReason ?? undefined}>
              {t(pausedByBreaker ? 'workflowsDashboard.pausedByBreaker' : 'workflowsDashboard.paused')}
            </span>
          )}
          {workflow.lastRunStatus && (
            <span className="status-pill" data-status={workflow.lastRunStatus}>{formatStatusLabel(workflow.lastRunStatus)}</span>
          )}
          {typeof workflow.runCount === 'number' && (
            <span className="we-list-row__count" title={t('workflowsDashboard.runCountTitle', { count: workflow.runCount })}>{workflow.runCount}</span>
          )}
          <WorkflowHealthBadge workflowId={workflow.id} showLabel={false} />
          {/* Keyboard / screen-reader equivalent of drag-to-folder: a native
              <select> is operable without a mouse. Only rendered once folders
              exist (same gate as the drag handle), so the flat no-folder list is
              unchanged. Reuses the same moveToFolder path the drag drop uses. */}
          {canWrite && hasFolders && (
            <select
              className="we-list-row__folder-select"
              value={workflow.folder ?? ''}
              aria-label={t('workflowsDashboard.moveToFolderAria', { name: workflow.name })}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => { event.stopPropagation(); void moveToFolder(workflow.id, event.target.value) }}
              data-testid={`workflows-move-folder-${workflow.id}`}
            >
              <option value="">{t('workflowsDashboard.ungroupedFolder')}</option>
              {folderChoices.map(folder => (
                <option key={folder} value={folder}>{folder}</option>
              ))}
            </select>
          )}
          {/* Only breaker pauses get a Resume: an upstream-outage pause clears
              itself when the status page recovers. An active workflow can
              continue a capped buffered window without changing pause state. */}
          {canWrite && pausedByBreaker && (
            <button
              onClick={(event) => { event.stopPropagation(); void resumeWorkflow(workflow.id) }}
              className="small-command"
              title={t('workflowsDashboard.resumeFlowTitle')}
              data-testid={`workflows-resume-${workflow.id}`}
              disabled={recoveryBusy}
            >
              <PlayCircle size={12} aria-hidden="true" /> {t('workflowsDashboard.resumeFlow')}
            </button>
          )}
          {canWrite && !isPaused && hasBufferedTriggers && (
            <button
              onClick={(event) => { event.stopPropagation(); void resumeWorkflow(workflow.id) }}
              className="small-command"
              title={t('workflowsDashboard.continueBackfillTitle', { count: workflow.bufferedTriggerCount ?? 0 })}
              data-testid={`workflows-backfill-${workflow.id}`}
              disabled={recoveryBusy}
            >
              <PlayCircle size={12} aria-hidden="true" /> {t('workflowsDashboard.continueBackfill')}
            </button>
          )}
          <button onClick={(event) => { event.stopPropagation(); onOpen(workflow.id) }} className="small-command">{t('workflowsDashboard.openFlow')}</button>
          {/* Soft-delete affordance: an inline confirm (one row at a time) so a
              click never deletes immediately. The delete is recoverable from the
              Trash view. stopPropagation so the controls never open the row. */}
          {!canWrite ? null : confirmDeleteId === workflow.id ? (
            <span className="we-list-row__confirm" onClick={(event) => event.stopPropagation()}>
              <span className="we-list-row__confirm-text">{t('workflowsDashboard.deleteConfirm', { name: workflow.name })}</span>
              <button
                type="button"
                className="small-command danger"
                onClick={(event) => { event.stopPropagation(); void deleteWorkflow(workflow.id) }}
                data-testid={`workflows-delete-confirm-${workflow.id}`}
              >
                {t('workflowsDashboard.confirmDeleteCta')}
              </button>
              <button
                type="button"
                className="small-command"
                onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(null) }}
              >
                {t('workflowsDashboard.cancelAction')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="small-command danger we-list-row__delete"
              onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(workflow.id) }}
              title={t('workflowsDashboard.deleteFlow', { name: workflow.name })}
              aria-label={t('workflowsDashboard.deleteFlow', { name: workflow.name })}
              data-testid={`workflows-delete-${workflow.id}`}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </li>
  )
})
