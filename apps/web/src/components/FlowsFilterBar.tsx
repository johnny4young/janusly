/**
 * Filter / sort toolbar for the active Flows list — name search, the multi-tag
 * filter (chips + picker + single-tag rename/delete), the folder filter, the
 * clear-all reset, the sort segment, and the bulk-select toggles. Rendered by
 * `WorkflowsDashboard.tsx` above the list.
 *
 * Presentation only: the container owns all filter/selection state and the tag
 * mutations; this component receives them as props. Sort keys come from the
 * shared `flows-filters` contract.
 */

import type { Dispatch, SetStateAction } from 'react'
import { FilterX, Pencil, Search, Trash2, X } from 'lucide-react'
import { useT } from '../i18n'
import type { SortKey } from '../flows-filters'

type TFunc = ReturnType<typeof useT>['t']

export type FlowsFilterBarProps = {
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  tagOptions: string[]
  tagFilters: string[]
  setTagFilters: Dispatch<SetStateAction<string[]>>
  soleTagFilter: string | undefined
  renamingTag: boolean
  setRenamingTag: Dispatch<SetStateAction<boolean>>
  tagRenameDraft: string
  setTagRenameDraft: Dispatch<SetStateAction<string>>
  renameTag: (from: string, to: string) => void | Promise<void>
  confirmDeleteTag: boolean
  setConfirmDeleteTag: Dispatch<SetStateAction<boolean>>
  deleteTag: (tag: string) => void | Promise<void>
  folderOptions: string[]
  folderFilter: string
  setFolderFilter: Dispatch<SetStateAction<string>>
  hasActiveFilters: boolean
  clearAllFilters: () => void
  sort: SortKey
  setSort: Dispatch<SetStateAction<SortKey>>
  selectionMode: boolean
  setSelectionMode: Dispatch<SetStateAction<boolean>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  allVisibleSelected: boolean
  toggleSelectAll: () => void
  visibleIds: string[]
  t: TFunc
}

export function FlowsFilterBar({
  query,
  setQuery,
  tagOptions,
  tagFilters,
  setTagFilters,
  soleTagFilter,
  renamingTag,
  setRenamingTag,
  tagRenameDraft,
  setTagRenameDraft,
  renameTag,
  confirmDeleteTag,
  setConfirmDeleteTag,
  deleteTag,
  folderOptions,
  folderFilter,
  setFolderFilter,
  hasActiveFilters,
  clearAllFilters,
  sort,
  setSort,
  selectionMode,
  setSelectionMode,
  setSelectedIds,
  allVisibleSelected,
  toggleSelectAll,
  visibleIds,
  t,
}: FlowsFilterBarProps) {
  return (
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
      {/* Multi-tag filter — selected tags are chips (✕ to drop one), and a
          "+ tag" picker adds another. Several tags AND together server-side. */}
      {(tagOptions.length > 0 || tagFilters.length > 0) && (
        <span className="we-list-filter-tags" data-testid="workflows-tag-filter">
          {tagFilters.map(tag => (
            <span key={tag} className="we-pill we-pill--ghost we-list-row__tag">
              {tag}
              <button
                type="button"
                className="we-list-row__tag-remove"
                aria-label={t('workflowsDashboard.removeTagFromFilterAria', { tag }) as string}
                title={t('workflowsDashboard.removeTagFromFilterAria', { tag }) as string}
                onClick={() => setTagFilters(prev => prev.filter(tg => tg !== tag))}
                data-testid={`workflows-tag-filter-remove-${tag}`}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
          {tagOptions.some(tag => !tagFilters.includes(tag)) && (
            <select
              className="text-field we-list-row__tag-add"
              value=""
              aria-label={t('workflowsDashboard.tagFilterAria') as string}
              onChange={event => { if (event.target.value) setTagFilters(prev => prev.includes(event.target.value) ? prev : [...prev, event.target.value]) }}
              data-testid="workflows-tag-filter-add"
            >
              <option value="">{t('workflowsDashboard.addTagPlaceholder')}</option>
              {tagOptions.filter(tag => !tagFilters.includes(tag)).map(tag => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          )}
        </span>
      )}
      {/* Manage the currently-filtered tag — rename it (re-key across the org)
          or delete it (strip from every workflow). Only shown when EXACTLY one
          tag is filtered; mirrors the folder-section rename/delete. */}
      {soleTagFilter && (
        renamingTag ? (
          <span className="we-list-tag-manage">
            <input
              className="text-field we-list-tag-manage__input"
              value={tagRenameDraft}
              autoFocus
              maxLength={40}
              aria-label={t('workflowsDashboard.renameTagLabel') as string}
              onChange={event => setTagRenameDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); void renameTag(soleTagFilter, tagRenameDraft) }
                else if (event.key === 'Escape') { event.preventDefault(); setRenamingTag(false) }
              }}
              data-testid="workflows-tag-rename-input"
            />
            <button type="button" className="small-command" onClick={() => void renameTag(soleTagFilter, tagRenameDraft)} data-testid="workflows-tag-rename-save">
              {t('workflowsDashboard.saveRename')}
            </button>
            <button type="button" className="small-command" onClick={() => setRenamingTag(false)}>
              {t('workflowsDashboard.cancelAction')}
            </button>
          </span>
        ) : confirmDeleteTag ? (
          <span className="we-list-tag-manage">
            <span className="we-list-tag-manage__confirm">{t('workflowsDashboard.deleteTagConfirm', { tag: soleTagFilter })}</span>
            <button type="button" className="small-command danger" onClick={() => void deleteTag(soleTagFilter)} data-testid="workflows-tag-delete-confirm">
              {t('workflowsDashboard.confirmDeleteCta')}
            </button>
            <button type="button" className="small-command" onClick={() => setConfirmDeleteTag(false)}>
              {t('workflowsDashboard.cancelAction')}
            </button>
          </span>
        ) : (
          <span className="we-list-tag-manage">
            <button
              type="button"
              className="small-command"
              onClick={() => { setConfirmDeleteTag(false); setTagRenameDraft(soleTagFilter); setRenamingTag(true) }}
              title={t('workflowsDashboard.renameTag', { tag: soleTagFilter }) as string}
              aria-label={t('workflowsDashboard.renameTag', { tag: soleTagFilter }) as string}
              data-testid="workflows-tag-rename"
            >
              <Pencil size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="small-command danger"
              onClick={() => { setRenamingTag(false); setConfirmDeleteTag(true) }}
              title={t('workflowsDashboard.deleteTag', { tag: soleTagFilter }) as string}
              aria-label={t('workflowsDashboard.deleteTag', { tag: soleTagFilter }) as string}
              data-testid="workflows-tag-delete"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </span>
        )
      )}
      {folderOptions.length > 0 && (
        <select
          className="text-field"
          value={folderFilter}
          onChange={event => setFolderFilter(event.target.value)}
          aria-label={t('workflowsDashboard.folderFilterAria') as string}
          data-testid="workflows-folder-filter"
        >
          <option value="">{t('workflowsDashboard.allFolders')}</option>
          {folderOptions.map(folder => (
            <option key={folder} value={folder}>{folder}</option>
          ))}
        </select>
      )}
      {/* One-click reset of the active search / tag / folder filters. Only
          shown when at least one is active; leaves sort + view state intact. */}
      {hasActiveFilters && (
        <button
          type="button"
          className="small-command"
          onClick={clearAllFilters}
          aria-label={t('workflowsDashboard.clearFilters') as string}
          data-testid="workflows-clear-filters"
        >
          <FilterX size={12} aria-hidden="true" />
          {t('workflowsDashboard.clearFilters')}
        </button>
      )}
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
      {/* Bulk-select toggle — reveals per-row checkboxes + the bulk bar. Off
          by default so the list is unchanged. */}
      <button
        type="button"
        className="small-command"
        aria-pressed={selectionMode}
        onClick={() => { setSelectionMode((on) => !on); setSelectedIds(new Set()) }}
        data-testid="workflows-select-toggle"
      >
        {selectionMode ? t('workflowsDashboard.selectDone') : t('workflowsDashboard.selectFlows')}
      </button>
      {/* Select-all toggle — lives in the toolbar (not the bulk bar, which
          only appears once ≥1 row is ticked) so it's reachable at 0 selected.
          Operates on `visible`, so it works in flat AND foldered views. */}
      {selectionMode && (
        <button
          type="button"
          className="small-command"
          aria-pressed={allVisibleSelected}
          onClick={toggleSelectAll}
          data-testid="workflows-select-all"
        >
          {allVisibleSelected
            ? t('workflowsDashboard.deselectAll')
            : t('workflowsDashboard.selectAllCount', { count: visibleIds.length })}
        </button>
      )}
    </div>
  )
}
