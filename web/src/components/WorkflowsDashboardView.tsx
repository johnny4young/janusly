import { AlertCircle, FilePlus2, FolderPlus, LayoutTemplate, ListChecks, Pencil, Plus, RefreshCw, Sparkles, Trash, Trash2, Workflow, X } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { FlowRow } from './FlowRow'
import { FlowsFilterBar } from './FlowsFilterBar'
import { TrashPanel } from './TrashPanel'
import type { SavedWorkflow } from '../types'
import type { WorkflowsDashboardController } from './WorkflowsDashboard'
import { UNGROUPED_FOLDER as UNGROUPED } from './workflows-dashboard-model'

export function WorkflowsDashboardView({ model }: { model: WorkflowsDashboardController }) {
  const {
    allVisibleSelected,
    bulkAssign,
    bulkAssignTag,
    bulkFolderDraft,
    bulkRestore,
    bulkTagDraft,
    canWrite,
    cancelNewFolder,
    clearAllFilters,
    collapsedFolders,
    commitNewFolder,
    confirmDeleteFolder,
    confirmDeleteId,
    confirmDeleteTag,
    creationOpen,
    deleteFolder,
    deleteTag,
    deleteWorkflow,
    draggingId,
    dropTarget,
    folderFilter,
    folderOptions,
    groups,
    hasActiveFilters,
    hasFolders,
    hasMore,
    load,
    loadError,
    loadMore,
    loading,
    loadingMore,
    moveToFolder,
    newFolderDraft,
    newFolderDropFor,
    newFolderHover,
    onCreate,
    onOpen,
    query,
    rememberFolderToggle,
    recoveryBusyIds,
    renameDraft,
    renameFolder,
    renameTag,
    renamingFolder,
    renamingTag,
    restoreWorkflow,
    resumeWorkflow,
    selectedIds,
    selectionMode,
    setBulkFolderDraft,
    setBulkTagDraft,
    setConfirmDeleteFolder,
    setConfirmDeleteId,
    setConfirmDeleteTag,
    setCreationOpen,
    setDraggingId,
    setDropTarget,
    setFolderFilter,
    setNewFolderDraft,
    setNewFolderDropFor,
    setNewFolderHover,
    setQuery,
    setRenameDraft,
    setRenamingFolder,
    setRenamingTag,
    setSelectedIds,
    setSelectionMode,
    setSort,
    setTagFilters,
    setTagRenameDraft,
    setRowTag,
    showToolbar,
    showTrashed,
    soleTagFilter,
    sort,
    t,
    tagFilters,
    tagOptions,
    tagRenameDraft,
    toggleFolder,
    toggleSelectAll,
    toggleSelectFolder,
    toggleSelected,
    toggleTrashView,
    trashNowMs,
    retentionDays,
    visible,
    visibleIds,
    workflows,
  } = model

  const renderRow = (workflow: SavedWorkflow) => (
    <FlowRow
      key={workflow.id}
      workflow={workflow}
      canWrite={canWrite}
      folderOptions={folderOptions}
      tagOptions={tagOptions}
      hasFolders={hasFolders}
      selectionMode={selectionMode}
      selectedIds={selectedIds}
      draggingId={draggingId}
      confirmDeleteId={confirmDeleteId}
      onOpen={onOpen}
      toggleSelected={toggleSelected}
      setDraggingId={setDraggingId}
      setDropTarget={setDropTarget}
      setConfirmDeleteId={setConfirmDeleteId}
      setRowTag={setRowTag}
      moveToFolder={moveToFolder}
      deleteWorkflow={deleteWorkflow}
      resumeWorkflow={resumeWorkflow}
      recoveryBusy={recoveryBusyIds.has(workflow.id)}
      t={t}
    />
  )

  return (
    <div className="panel-list">
      <div className="panel-toolbar">
        <div>
          <strong>
            {showTrashed
              ? t('workflowsDashboard.trashTitle', { count: workflows.length })
              : t('workflowsDashboard.savedFlows', { count: workflows.length })}
          </strong>
          <p className="helper-text">{showTrashed ? t('workflowsDashboard.trashHelper') : t('workflowsDashboard.helper')}</p>
        </div>
        <div className="panel-toolbar__actions">
          {!showTrashed && onCreate && (
            <button
              type="button"
              className="small-command small-command--primary"
              onClick={() => setCreationOpen((open) => !open)}
              aria-expanded={creationOpen}
              aria-controls="workflow-creation-choices"
              disabled={!canWrite}
            >
              <Plus size={14} aria-hidden="true" /> {t('workflowsDashboard.newWorkflow')}
            </button>
          )}
          {/* Trash toggle — always reachable (it lives in the always-rendered
              header, not the filterable toolbar). Entering Trash clears any
              active-view selection + delete-confirm so the views don't bleed. */}
          <button
            type="button"
            className="small-command"
            aria-pressed={showTrashed}
            onClick={toggleTrashView}
            data-testid="workflows-trash-toggle"
          >
            {showTrashed ? (
              <><Workflow size={14} aria-hidden="true" /> {t('workflowsDashboard.trashToggleToActive')}</>
            ) : (
              <><Trash size={14} aria-hidden="true" /> {t('workflowsDashboard.trashToggleToTrash')}</>
            )}
          </button>
          <button onClick={load} className="small-command" disabled={loading} aria-label={t('workflowsDashboard.refresh')}>
            <RefreshCw size={14} aria-hidden="true" /> {loading ? t('workflowsDashboard.loading') : t('workflowsDashboard.refresh')}
          </button>
        </div>
      </div>

      {!showTrashed && creationOpen && onCreate && (
        <section
          id="workflow-creation-choices"
          className="workflow-creation"
          aria-labelledby="workflow-creation-title"
          data-testid="workflow-creation-choices"
        >
          <div className="workflow-creation__intro">
            <div>
              <span className="section-kicker">{t('workflowCreation.kicker')}</span>
              <h3 id="workflow-creation-title">{t('workflowCreation.title')}</h3>
              <p>{t('workflowCreation.body')}</p>
            </div>
            <button
              type="button"
              className="small-command"
              onClick={() => setCreationOpen(false)}
              aria-label={t('workflowCreation.close')}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="workflow-creation__choices">
            <button
              type="button"
              className="workflow-creation__choice workflow-creation__choice--primary"
              onClick={() => onCreate('describe')}
            >
              <span className="workflow-creation__icon" aria-hidden="true"><Sparkles size={19} /></span>
              <span>
                <strong>{t('workflowCreation.describe.title')}</strong>
                <small>{t('workflowCreation.describe.body')}</small>
              </span>
            </button>
            <button
              type="button"
              className="workflow-creation__choice"
              onClick={() => onCreate('blank')}
            >
              <span className="workflow-creation__icon" aria-hidden="true"><FilePlus2 size={18} /></span>
              <span>
                <strong>{t('workflowCreation.blank.title')}</strong>
                <small>{t('workflowCreation.blank.body')}</small>
              </span>
            </button>
            <button
              type="button"
              className="workflow-creation__choice"
              onClick={() => onCreate('template')}
            >
              <span className="workflow-creation__icon" aria-hidden="true"><LayoutTemplate size={18} /></span>
              <span>
                <strong>{t('workflowCreation.template.title')}</strong>
                <small>{t('workflowCreation.template.body')}</small>
              </span>
            </button>
          </div>
        </section>
      )}

      {showToolbar && !showTrashed && (
        <FlowsFilterBar
          canWrite={canWrite}
          query={query}
          setQuery={setQuery}
          tagOptions={tagOptions}
          tagFilters={tagFilters}
          setTagFilters={setTagFilters}
          soleTagFilter={soleTagFilter}
          renamingTag={renamingTag}
          setRenamingTag={setRenamingTag}
          tagRenameDraft={tagRenameDraft}
          setTagRenameDraft={setTagRenameDraft}
          renameTag={renameTag}
          confirmDeleteTag={confirmDeleteTag}
          setConfirmDeleteTag={setConfirmDeleteTag}
          deleteTag={deleteTag}
          folderOptions={folderOptions}
          folderFilter={folderFilter}
          setFolderFilter={setFolderFilter}
          hasActiveFilters={hasActiveFilters}
          clearAllFilters={clearAllFilters}
          sort={sort}
          setSort={setSort}
          selectionMode={selectionMode}
          setSelectionMode={setSelectionMode}
          setSelectedIds={setSelectedIds}
          allVisibleSelected={allVisibleSelected}
          toggleSelectAll={toggleSelectAll}
          visibleIds={visibleIds}
          t={t}
        />
      )}

      {canWrite && !showTrashed && selectionMode && selectedIds.size > 0 && (
        <div className="we-list-bulk-bar" data-testid="workflows-bulk-bar">
          <span className="we-list-bulk-bar__count">{t('workflowsDashboard.bulkSelectedCount', { count: selectedIds.size })}</span>
          <input
            className="text-field we-list-bulk-bar__input"
            list="we-bulk-folder-options"
            value={bulkFolderDraft}
            maxLength={60}
            onChange={event => setBulkFolderDraft(event.target.value)}
            placeholder={t('workflowsDashboard.bulkFolderPlaceholder')}
            aria-label={t('workflowsDashboard.bulkFolderPlaceholder')}
            data-testid="workflows-bulk-folder-input"
          />
          <datalist id="we-bulk-folder-options">
            {folderOptions.map(folder => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
          <button
            type="button"
            className="small-command"
            disabled={!bulkFolderDraft.trim()}
            onClick={() => void bulkAssign(bulkFolderDraft.trim())}
            data-testid="workflows-bulk-move"
          >
            {t('workflowsDashboard.bulkMoveCta')}
          </button>
          <button
            type="button"
            className="small-command"
            onClick={() => void bulkAssign(null)}
            data-testid="workflows-bulk-ungroup"
          >
            {t('workflowsDashboard.bulkUngroupCta')}
          </button>
          {/* Tag group — add OR remove ONE tag across the selected rows. A tag is
              multi-value (a workflow can carry several), so unlike the folder
              Move/Ungroup this has two verbs instead of a single target. */}
          <span className="we-list-bulk-bar__divider" aria-hidden="true" />
          <input
            className="text-field we-list-bulk-bar__input"
            list="we-bulk-tag-options"
            value={bulkTagDraft}
            maxLength={40}
            onChange={event => setBulkTagDraft(event.target.value)}
            placeholder={t('workflowsDashboard.bulkTagPlaceholder')}
            aria-label={t('workflowsDashboard.bulkTagPlaceholder')}
            data-testid="workflows-bulk-tag-input"
          />
          <datalist id="we-bulk-tag-options">
            {tagOptions.map(tag => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
          <button
            type="button"
            className="small-command"
            disabled={!bulkTagDraft.trim()}
            onClick={() => void bulkAssignTag('add')}
            data-testid="workflows-bulk-tag-add"
          >
            {t('workflowsDashboard.bulkTagAddCta')}
          </button>
          <button
            type="button"
            className="small-command"
            disabled={!bulkTagDraft.trim()}
            onClick={() => void bulkAssignTag('remove')}
            data-testid="workflows-bulk-tag-remove"
          >
            {t('workflowsDashboard.bulkTagRemoveCta')}
          </button>
          <button type="button" className="small-command" onClick={() => setSelectedIds(new Set())}>
            {t('workflowsDashboard.clearSelection')}
          </button>
        </div>
      )}

      {/* Initial load (active or trash) — skeleton rows instead of a blank gap
          until the first page arrives. */}
      {loading && workflows.length === 0 && (
        <LoadingSkeleton rows={5} label={t('workflowsDashboard.loading')} />
      )}

      {loadError && workflows.length === 0 && !loading && (
        <EmptyState
          icon={<AlertCircle size={18} />}
          kicker={t('workflowsDashboard.loadErrorTitle')}
          body={loadError}
          cta={{ label: t('workflowsDashboard.retry'), onClick: () => void load() }}
          testId="workflows-load-error"
        />
      )}

      {/* Trash view — a flat, filter-free list of soft-deleted workflows (uses
          the raw server-ordered `workflows`, NOT `visible`, so a stale active-
          view search term never filters it). Restore-only; no folders/tags/bulk. */}
      {showTrashed && !loadError && (
        <TrashPanel
          canWrite={canWrite}
          workflows={workflows}
          loading={loading}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          toggleSelected={toggleSelected}
          restoreWorkflow={restoreWorkflow}
          bulkRestore={bulkRestore}
          retentionDays={retentionDays}
          trashNowMs={trashNowMs}
          t={t}
        />
      )}

      {/* Empty-state precedence — one chain over `visible.length === 0` (covers
          both an empty server result and a client-narrowed page). The active
          search wins the message (it's the most recent narrowing, and the
          server `?q=` can itself yield 0 rows), then folder, then tag, then the
          genuine all-clear (no flows, no filters). */}
      {!showTrashed && visible.length === 0 && !loading && !loadError && (
        query.trim() !== '' ? (
          <p className="helper-text" data-testid="workflows-no-matches">{t('workflowsDashboard.noMatches')}</p>
        ) : folderFilter !== '' ? (
          <p className="helper-text" data-testid="workflows-no-folder-matches">
            {t('workflowsDashboard.noFolderMatches', { folder: folderFilter })}
          </p>
        ) : tagFilters.length > 0 ? (
          <p className="helper-text" data-testid="workflows-no-tag-matches">
            {t('workflowsDashboard.noTagMatches', { tags: tagFilters.join(', ') })}
          </p>
        ) : (
          <EmptyState
            icon={<ListChecks size={18} />}
            kicker={t('workflowsDashboard.empty')}
            body={canWrite
              ? t('workflowsDashboard.emptyHelper')
              : t('workflowsDashboard.emptyReadOnlyHelper')}
            cta={canWrite && onCreate
              ? {
                label: t('workflowsDashboard.newWorkflow'),
                onClick: () => setCreationOpen(true),
              }
              : undefined}
            testId="workflows-empty"
          />
        )
      )}

      {!showTrashed && visible.length > 0 && !hasFolders && (
        <ul className="we-list">
          {visible.map(renderRow)}
        </ul>
      )}

      {!showTrashed && visible.length > 0 && hasFolders && (
        <div className="we-list-folders" data-testid="workflows-folder-groups">
          {groups.map(group => {
            const label = group.key === UNGROUPED ? (t('workflowsDashboard.ungroupedFolder')) : group.key
            return (
              <details
                key={group.key === UNGROUPED ? '__ungrouped__' : group.key}
                className="we-list-folder"
                // When a folder filter is active there's exactly one matching
                // section and the operator explicitly asked to see it, so force
                // it open even if it was previously collapsed — otherwise
                // filtering to a collapsed folder shows an empty-looking section.
                // The collapse preference is untouched, so it's respected again
                // once the filter is cleared.
                open={folderFilter !== '' || !collapsedFolders.includes(group.key)}
                onToggle={event => {
                  const target = event.currentTarget as HTMLDetailsElement
                  if (folderFilter !== '') {
                    // The active filter owns visibility. Re-open after a native
                    // toggle attempt without mutating the saved collapse set.
                    if (!target.open) target.open = true
                    return
                  }
                  toggleFolder(group.key, target.open)
                }}
                // The whole section is a drop zone for a dragged row. dragOver
                // continuously sets the hovered key (so moving between sections
                // updates the highlight); drop reassigns the row's folder.
                onDragOver={draggingId ? (event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== group.key) setDropTarget(group.key)
                } : undefined}
                onDrop={(event) => {
                  event.preventDefault()
                  const droppedId = event.dataTransfer.getData('text/plain') || draggingId
                  setDropTarget(null)
                  setDraggingId(null)
                  if (droppedId) void moveToFolder(droppedId, group.key)
                }}
                data-drop-target={dropTarget === group.key && draggingId ? 'true' : undefined}
                data-testid={`workflows-folder-${group.key === UNGROUPED ? 'ungrouped' : group.key}`}
              >
                <summary
                  className="we-list-folder__summary"
                  onClick={event => {
                    if (folderFilter !== '') return
                    const details = event.currentTarget.parentElement as HTMLDetailsElement
                    // The browser dispatches `toggle` asynchronously after the
                    // summary's default action. Record the intended next state
                    // during `click`, before an immediate reload can cancel it.
                    // Do not set React state here: changing the controlled
                    // `open` prop before the default action would make the
                    // browser toggle it back in the opposite direction.
                    rememberFolderToggle(group.key, !details.open)
                  }}
                >
                  {renamingFolder === group.key ? (
                    // Inline rename: the controls preventDefault so a click never
                    // toggles the <details>; Enter saves, Esc cancels.
                    <span className="we-list-folder__rename" onClick={event => { event.preventDefault(); event.stopPropagation() }}>
                      <input
                        className="text-field we-list-folder__rename-input"
                        value={renameDraft}
                        autoFocus
                        maxLength={60}
                        aria-label={t('workflowsDashboard.renameFolderLabel')}
                        onChange={event => setRenameDraft(event.target.value)}
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => {
                          if (event.key === 'Enter') { event.preventDefault(); void renameFolder(group.key, renameDraft) }
                          else if (event.key === 'Escape') { event.preventDefault(); setRenamingFolder(null) }
                        }}
                        data-testid={`workflows-renamefolder-input-${group.key}`}
                      />
                      <button type="button" className="small-command" onClick={event => { event.preventDefault(); event.stopPropagation(); void renameFolder(group.key, renameDraft) }} data-testid={`workflows-renamefolder-save-${group.key}`}>
                        {t('workflowsDashboard.saveRename')}
                      </button>
                      <button type="button" className="small-command" onClick={event => { event.preventDefault(); event.stopPropagation(); setRenamingFolder(null) }}>
                        {t('workflowsDashboard.cancelAction')}
                      </button>
                    </span>
                  ) : confirmDeleteFolder === group.key ? (
                    <span className="we-list-folder__confirm" onClick={event => { event.preventDefault(); event.stopPropagation() }}>
                      <span className="we-list-folder__confirm-text">{t('workflowsDashboard.deleteFolderConfirm', { folder: group.key, count: group.items.length })}</span>
                      <button type="button" className="small-command danger" onClick={event => { event.preventDefault(); event.stopPropagation(); void deleteFolder(group.key) }} data-testid={`workflows-deletefolder-confirm-${group.key}`}>
                        {t('workflowsDashboard.confirmDeleteCta')}
                      </button>
                      <button type="button" className="small-command" onClick={event => { event.preventDefault(); event.stopPropagation(); setConfirmDeleteFolder(null) }}>
                        {t('workflowsDashboard.cancelAction')}
                      </button>
                    </span>
                  ) : (
                    <>
                      {/* Select-all-in-folder — a button (not a checkbox): inside a
                          <summary>, preventDefault is needed to stop the native
                          <details> toggle, and that would also cancel a checkbox's
                          own tick. Same preventDefault+stopPropagation as the
                          rename/delete controls. Only in selection mode. */}
                      {canWrite && selectionMode && (
                        <button
                          type="button"
                          className="small-command we-list-folder__selectall"
                          aria-pressed={group.items.every((w) => selectedIds.has(w.id))}
                          onClick={event => { event.preventDefault(); event.stopPropagation(); toggleSelectFolder(group.items) }}
                          title={t('workflowsDashboard.selectAllInFolderAria', { folder: label })}
                          aria-label={t('workflowsDashboard.selectAllInFolderAria', { folder: label })}
                          data-testid={`workflows-select-folder-${group.key === UNGROUPED ? 'ungrouped' : group.key}`}
                        >
                          <ListChecks size={12} aria-hidden="true" />
                        </button>
                      )}
                      <span className="we-list-folder__name">{label}</span>
                      <span className="we-pill" data-tone="ghost">{t('workflowsDashboard.folderCount', { count: group.items.length })}</span>
                      {/* Rename / delete only for NAMED folders — "Ungrouped" is a
                          synthetic bucket, not a real folder to manage. */}
                      {canWrite && group.key !== UNGROUPED && (
                        <span className="we-list-folder__actions">
                          <button
                            type="button"
                            className="small-command"
                            onClick={event => { event.preventDefault(); event.stopPropagation(); setConfirmDeleteFolder(null); setRenameDraft(group.key); setRenamingFolder(group.key) }}
                            title={t('workflowsDashboard.renameFolder', { folder: group.key })}
                            aria-label={t('workflowsDashboard.renameFolder', { folder: group.key })}
                            data-testid={`workflows-renamefolder-${group.key}`}
                          >
                            <Pencil size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="small-command danger"
                            onClick={event => { event.preventDefault(); event.stopPropagation(); setRenamingFolder(null); setConfirmDeleteFolder(group.key) }}
                            title={t('workflowsDashboard.deleteFolder', { folder: group.key })}
                            aria-label={t('workflowsDashboard.deleteFolder', { folder: group.key })}
                            data-testid={`workflows-deletefolder-${group.key}`}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </span>
                      )}
                    </>
                  )}
                </summary>
                <ul className="we-list">
                  {group.items.map(renderRow)}
                </ul>
              </details>
            )
          })}
          {/* Drag-to-create-folder zone — only while dragging a row, or naming a
              just-dropped one. Dropping opens an inline name input; the row is
              assigned to that name via the same moveToFolder path the drag-to-
              existing-folder drop uses, and the section springs into existence
              (folders derive from each row's folder value — no folders table). */}
          {newFolderDropFor !== null ? (
            <div className="we-list-folder-new we-list-folder-new--naming">
              <input
                className="text-field we-list-folder-new__input"
                value={newFolderDraft}
                autoFocus
                maxLength={60}
                placeholder={t('workflowsDashboard.newFolderPlaceholder')}
                aria-label={t('workflowsDashboard.newFolderLabel')}
                onChange={event => setNewFolderDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); commitNewFolder() }
                  else if (event.key === 'Escape') { event.preventDefault(); cancelNewFolder() }
                }}
                data-testid="workflows-newfolder-input"
              />
              <button type="button" className="small-command" onClick={commitNewFolder} data-testid="workflows-newfolder-save">
                {t('workflowsDashboard.saveNewFolder')}
              </button>
              <button type="button" className="small-command" onClick={cancelNewFolder}>
                {t('workflowsDashboard.cancelAction')}
              </button>
            </div>
          ) : draggingId ? (
            <div
              className="we-list-folder-new"
              data-drop-target={newFolderHover ? 'true' : undefined}
              onDragOver={event => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (!newFolderHover) setNewFolderHover(true)
              }}
              onDragLeave={() => setNewFolderHover(false)}
              onDrop={event => {
                event.preventDefault()
                const droppedId = event.dataTransfer.getData('text/plain') || draggingId
                setNewFolderHover(false)
                setDropTarget(null)
                setDraggingId(null)
                if (droppedId) { setNewFolderDraft(''); setNewFolderDropFor(droppedId) }
              }}
              data-testid="workflows-newfolder-dropzone"
            >
              <FolderPlus size={14} aria-hidden="true" />
              <span>{t('workflowsDashboard.newFolderDropzone')}</span>
            </div>
          ) : null}
        </div>
      )}

      {/* Keyset "Load more" — appends the next page after the oldest loaded row.
          Shown below both the flat and folder-grouped views when the last page
          came back full. */}
      {hasMore && (
        <button
          type="button"
          className="small-command we-load-more"
          onClick={() => { void loadMore() }}
          disabled={loadingMore}
          data-testid="workflows-load-more"
        >
          {loadingMore ? t('workflowsDashboard.loading') : t('workflowsDashboard.loadMore')}
        </button>
      )}
    </div>
  )
}
