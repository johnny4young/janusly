/**
 * Saved-workflows list — calls `/workflows` and renders each as an
 * openable row. Re-fetches on `platformVersion` changes (cross-panel
 * reactivity hook from AGENTS.md).
 *
 * Used by `RightPanel.tsx` (the `workflows` tab).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleCheck, Folder, FolderPlus, GripVertical, ListChecks, Pencil, RefreshCw, Search, Trash2, Workflow, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'
import { WorkflowHealthBadge } from './WorkflowHealthBadge'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { readFlowsFilters, writeFlowsFilters, type SortKey } from '../flows-filters'

/** Run statuses that count as "failed" for the failed-first sort (mirrors
 *  the server's terminal-failure set). */
const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled', 'timed_out'])

/** Sentinel key for the "Ungrouped" folder section. A real folder name is
 *  `min(1)` chars, so the empty string can never collide with one. */
const UNGROUPED = ''

/** One Flows-list folder section: the folder key (`UNGROUPED` = no folder) and
 *  its workflows, in the same order the global filter+sort produced. */
type FolderGroup = { key: string; items: SavedWorkflow[] }

/** Render the saved-workflows list with click-to-open + manual refresh. */
export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)
  // Drag-to-folder transient state. `draggingId` is the row being dragged;
  // `dropTarget` is the folder key (`UNGROUPED` = '') currently hovered, used
  // only for the highlight. Both clear on drop / drag-end.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Drag-to-create-folder transient state. A row dropped on the "+ New folder"
  // zone is held in `newFolderDropFor` while its inline name input is open;
  // `newFolderDraft` is that input's text, `newFolderHover` the drop highlight.
  const [newFolderHover, setNewFolderHover] = useState(false)
  const [newFolderDropFor, setNewFolderDropFor] = useState<string | null>(null)
  const [newFolderDraft, setNewFolderDraft] = useState('')
  // Tag / search / sort restore from localStorage on mount (per-browser) so the
  // Flows view survives navigation + reload; persisted by the effect below. A
  // missing / corrupt value degrades to the defaults via the helper.
  const [query, setQuery] = useState(() => readFlowsFilters()?.query ?? '')
  const [sort, setSort] = useState<SortKey>(() => readFlowsFilters()?.sort ?? 'recent')
  // Server-side tag filter — multiple tags AND together (a row must carry ALL of
  // them). The picker lists ALL the org's tags + matches surface beyond the list
  // cap; `[]` means "All tags".
  const [tagFilters, setTagFilters] = useState<string[]>(() => readFlowsFilters()?.tags ?? [])
  const [tagOptions, setTagOptions] = useState<string[]>([])
  // Server-side folder filter — same shape as the tag filter (the dropdown lists
  // ALL the org's folders + matches surface beyond the list cap, which is what
  // makes a folder's members visible past the 100/200 cap that the client-side
  // grouping alone can't reach); '' means "All folders".
  const [folderFilter, setFolderFilter] = useState(() => readFlowsFilters()?.folder ?? '')
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  // Collapsed folder sections (persisted per-browser). A stale entry (folder
  // renamed/deleted since) simply matches no rendered section — a harmless no-op.
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(
    () => readFlowsFilters()?.collapsedFolders ?? [],
  )
  // Folder management (rename / delete) transient state — at most one folder is
  // being renamed or delete-confirmed at a time. `renameDraft` holds the in-progress
  // new name while `renamingFolder` is set.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null)
  // Tag management for the active tag filter — rename / delete the one selected
  // tag across the whole org. Shown only when EXACTLY one tag is filtered, so
  // these are simple flags keyed off `tagFilters[0]`.
  const [renamingTag, setRenamingTag] = useState(false)
  const [tagRenameDraft, setTagRenameDraft] = useState('')
  const [confirmDeleteTag, setConfirmDeleteTag] = useState(false)
  // Bulk folder assignment. `selectionMode` toggles per-row checkboxes (off by
  // default so the list is unchanged); `selectedIds` are the ticked rows;
  // `bulkFolderDraft` is the target folder typed/picked in the bulk bar.
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkFolderDraft, setBulkFolderDraft] = useState('')
  // `bulkTagDraft` is the tag typed/picked for the bulk add/remove buttons.
  const [bulkTagDraft, setBulkTagDraft] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      // Repeated `?tag=` params — the server ANDs them.
      tagFilters.forEach(tag => params.append('tag', tag))
      if (folderFilter) params.set('folder', folderFilter)
      const qs = params.toString()
      const data = await api(`/workflows${qs ? `?${qs}` : ''}`)
      setWorkflows(Array.isArray(data) ? data : [])
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('workflowsDashboard.toastFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast, t, tagFilters, folderFilter])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  // Persist the tag / folder / search / sort / collapsed-folders view
  // per-browser so it survives navigation + reload. The initial run re-writes
  // the restored values (a harmless no-op).
  useEffect(() => {
    writeFlowsFilters({ tags: tagFilters, folder: folderFilter, query, sort, collapsedFolders })
  }, [tagFilters, folderFilter, query, sort, collapsedFolders])

  // The org's distinct tags for the filter dropdown. Refetched on
  // `platformVersion` so an inspector tag edit refreshes the options. A fetch
  // failure is non-fatal — the dropdown just stays empty; the list still works.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api('/workflows/tags') as { tags?: unknown }
        const tags = Array.isArray(data?.tags) ? (data.tags as string[]) : []
        if (cancelled) return
        setTagOptions(tags)
        // Drop restored filter tags the org no longer offers (e.g. deleted since
        // the last visit) so the filter can't strand the list on an empty,
        // un-clearable view. The functional update reads the current filters
        // without adding them to this effect's deps.
        setTagFilters(current => current.filter(tg => tags.includes(tg)))
      } catch {
        if (!cancelled) setTagOptions([])
      }
    })()
    return () => { cancelled = true }
  }, [platformVersion])

  // The org's distinct folders for the folder-filter dropdown — mirror of the
  // tag-options effect (refetch on `platformVersion` so an inspector folder edit
  // refreshes the options; non-fatal on failure; reconcile a stale restored
  // folder the org no longer offers).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api('/workflows/folders') as { folders?: unknown }
        const folders = Array.isArray(data?.folders) ? (data.folders as string[]) : []
        if (cancelled) return
        setFolderOptions(folders)
        setFolderFilter(current => (current !== '' && !folders.includes(current) ? '' : current))
      } catch {
        if (!cancelled) setFolderOptions([])
      }
    })()
    return () => { cancelled = true }
  }, [platformVersion])

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

  // Ids of the currently-visible (filtered + sorted) rows — the universe for the
  // "Select all" control. Bounded by the list page cap, so well under the
  // bulk-assign cap; no extra bound needed.
  const visibleIds = useMemo(() => visible.map((w) => w.id), [visible])
  // True when every visible row is already ticked — drives the global toggle's
  // label ("Select all" vs "Deselect all") and pressed state.
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  // Keep the toolbar visible whenever filtering is meaningful OR a filter is
  // active — otherwise a tag/folder filter that narrows the (server-filtered)
  // list to ≤1 row would hide the toolbar and trap the user with no way to clear it.
  const showToolbar =
    tagOptions.length > 0 ||
    folderOptions.length > 0 ||
    workflows.length > 1 ||
    tagFilters.length > 0 ||
    folderFilter !== '' ||
    query.trim() !== ''

  // The single tag being filtered, when EXACTLY one is selected — drives the
  // rename/delete manage affordance, which operates on one tag at a time.
  const soleTagFilter = tagFilters.length === 1 ? tagFilters[0] : undefined

  // Group the already-filtered+sorted rows by folder. Named folders come first
  // (alphabetical, locale-aware); the "Ungrouped" bucket is always last. The
  // in-bucket order is preserved, so the global sort still applies within a
  // folder. No extra fetch — folders ride on the same list row.
  const groups = useMemo<FolderGroup[]>(() => {
    const buckets = new Map<string, SavedWorkflow[]>()
    for (const workflow of visible) {
      const key = workflow.folder && workflow.folder.trim() ? workflow.folder : UNGROUPED
      const existing = buckets.get(key)
      if (existing) existing.push(workflow)
      else buckets.set(key, [workflow])
    }
    const named = [...buckets.keys()]
      .filter((key) => key !== UNGROUPED)
      .sort((a, b) => a.localeCompare(b, getResolvedLocale()))
    const ordered = buckets.has(UNGROUPED) ? [...named, UNGROUPED] : named
    return ordered.map((key) => ({ key, items: buckets.get(key) ?? [] }))
  }, [visible])

  // Only render folder sections once at least one workflow has a folder —
  // otherwise the list stays the flat `<ul>` (byte-for-byte the pre-folders UI),
  // so an org that never uses folders sees no change.
  const hasFolders = groups.some((group) => group.key !== UNGROUPED)

  const toggleFolder = useCallback((key: string, open: boolean) => {
    setCollapsedFolders((prev) => {
      const collapsed = prev.includes(key)
      if (open && collapsed) return prev.filter((entry) => entry !== key)
      if (!open && !collapsed) return [...prev, key]
      return prev
    })
  }, [])

  // Reassign a workflow's folder by dropping its row onto a folder section.
  // `folderKey === UNGROUPED` clears the folder (null). Optimistic: re-group
  // the row immediately, POST the narrow folder-only route, then bump so the
  // folder dropdown options + authoritative rows refresh. Roll back on failure.
  const moveToFolder = useCallback(
    async (workflowId: string, folderKey: string) => {
      const folder = folderKey === UNGROUPED ? null : folderKey
      const current = workflows.find((w) => w.id === workflowId)
      if (!current) return
      const previousFolder = current.folder ?? null
      if (previousFolder === folder) return // already in this folder — no-op

      setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, folder } : w)))
      try {
        await api(`/workflows/${encodeURIComponent(workflowId)}/folder`, {
          method: 'POST',
          body: JSON.stringify({ folder }),
        })
        addToast(
          folder
            ? (t('workflowsDashboard.movedToFolder', { folder }) as string)
            : (t('workflowsDashboard.movedToUngrouped') as string),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (w.id === workflowId ? { ...w, folder: previousFolder } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.moveFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Add or remove ONE tag on a single row inline (the per-row equivalent of the
  // bulk tag bar). Optimistic: re-tag the row (add → append, remove → filter),
  // capturing the prior tags for an exact rollback, then POST the narrow per-id
  // route. `tagOptions` is left to the reload — add only offers existing tags, and
  // remove is org-wide distinct, so the dropdown reconciles on the bump.
  const setRowTag = useCallback(
    async (workflowId: string, tag: string, op: 'add' | 'remove') => {
      const current = workflows.find((w) => w.id === workflowId)
      if (!current) return
      const prior = current.tags ?? []
      if (op === 'add' && prior.includes(tag)) return
      if (op === 'remove' && !prior.includes(tag)) return
      const next = op === 'add' ? [...prior, tag] : prior.filter((t) => t !== tag)

      setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, tags: next } : w)))
      try {
        await api(`/workflows/${encodeURIComponent(workflowId)}/tags`, {
          method: 'POST',
          body: JSON.stringify({ tag, op }),
        })
        addToast(
          op === 'add'
            ? (t('workflowsDashboard.rowTagAdded', { tag }) as string)
            : (t('workflowsDashboard.rowTagRemoved', { tag }) as string),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, tags: prior } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.rowTagFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Create a folder by naming the row dropped on the "+ New folder" zone. Folders
  // are derived from each row's `folder` value, so assigning a never-seen name via
  // the existing `moveToFolder` makes the section spring into existence — no new
  // route. An empty / whitespace-only name cancels silently (the row stays put).
  const commitNewFolder = useCallback(() => {
    const id = newFolderDropFor
    const name = newFolderDraft.trim()
    setNewFolderDropFor(null)
    setNewFolderDraft('')
    if (!id || !name) return
    void moveToFolder(id, name)
  }, [newFolderDropFor, newFolderDraft, moveToFolder])

  // Dismiss the new-folder input without moving the dropped row.
  const cancelNewFolder = useCallback(() => {
    setNewFolderDropFor(null)
    setNewFolderDraft('')
  }, [])

  // Rename a folder across ALL its members in one bulk write. Optimistic: re-key
  // every matching row locally (tracked by id so the rollback is exact even if
  // `to` already existed and merged), POST the collection route, bump on success,
  // roll back on failure. Whitespace-only / unchanged names are a no-op.
  const renameFolder = useCallback(
    async (from: string, to: string) => {
      setRenamingFolder(null)
      const trimmed = to.trim()
      if (!trimmed || trimmed === from) return
      const affectedIds = new Set(workflows.filter((w) => w.folder === from).map((w) => w.id))
      if (affectedIds.size === 0) return

      setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder: trimmed } : w)))
      try {
        await api('/workflows/folders/rename', {
          method: 'POST',
          body: JSON.stringify({ from, to: trimmed }),
        })
        addToast(t('workflowsDashboard.folderRenamed', { folder: trimmed }) as string, 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder: from } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.renameFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Delete a folder by moving every member to Ungrouped (folder: null). The
  // workflows are untouched — only the label is cleared, so it's reversible.
  // Optimistic, tracked by id for an exact rollback.
  const deleteFolder = useCallback(
    async (folder: string) => {
      setConfirmDeleteFolder(null)
      const affectedIds = new Set(workflows.filter((w) => w.folder === folder).map((w) => w.id))
      if (affectedIds.size === 0) return

      setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder: null } : w)))
      try {
        await api('/workflows/folders/delete', {
          method: 'POST',
          body: JSON.stringify({ folder }),
        })
        addToast(t('workflowsDashboard.folderDeleted') as string, 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.deleteFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Rename the active-filter tag to `to` across the whole org. Optimistic: re-map
  // every loaded row's tags (from → to, deduped), refresh the tag dropdown, and
  // point the filter at the new name so the view follows. Org-scoped server-side;
  // prior tags captured for an exact rollback. No-op on empty / unchanged name.
  const renameTag = useCallback(
    async (from: string, to: string) => {
      setRenamingTag(false)
      const trimmed = to.trim()
      if (!trimmed || trimmed === from) return
      const idSet = new Set(workflows.filter((w) => (w.tags ?? []).includes(from)).map((w) => w.id))
      const priorTags = new Map(workflows.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.tags ?? []]))

      setWorkflows((prev) =>
        prev.map((w) => {
          if (!idSet.has(w.id)) return w
          const next = (w.tags ?? []).filter((tg) => tg !== from)
          if (!next.includes(trimmed)) next.push(trimmed)
          return { ...w, tags: next }
        }),
      )
      setTagOptions((prev) => {
        const next = prev.filter((tg) => tg !== from)
        if (!next.includes(trimmed)) next.push(trimmed)
        return next.sort((a, b) => a.localeCompare(b, getResolvedLocale()))
      })
      setTagFilters((prev) => [...new Set(prev.map((tg) => (tg === from ? trimmed : tg)))])
      try {
        await api('/workflows/tags/rename', { method: 'POST', body: JSON.stringify({ from, to: trimmed }) })
        addToast(t('workflowsDashboard.tagRenamed', { tag: trimmed }) as string, 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)))
        setTagOptions((prev) => {
          const next = prev.filter((tg) => tg !== trimmed)
          if (!next.includes(from)) next.push(from)
          return next.sort((a, b) => a.localeCompare(b, getResolvedLocale()))
        })
        setTagFilters((prev) => [...new Set(prev.map((tg) => (tg === trimmed ? from : tg)))])
        addToast(tApiError(err) || (t('workflowsDashboard.renameTagFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Delete the active-filter tag from every workflow in the org. Optimistic:
  // strip it from each loaded row, drop it from the dropdown, clear the filter.
  // The workflows themselves are untouched (only the label is removed). Rollback
  // on failure.
  const deleteTag = useCallback(
    async (tag: string) => {
      setConfirmDeleteTag(false)
      const idSet = new Set(workflows.filter((w) => (w.tags ?? []).includes(tag)).map((w) => w.id))
      const priorTags = new Map(workflows.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.tags ?? []]))

      setWorkflows((prev) =>
        prev.map((w) => (idSet.has(w.id) ? { ...w, tags: (w.tags ?? []).filter((tg) => tg !== tag) } : w)),
      )
      setTagOptions((prev) => prev.filter((tg) => tg !== tag))
      setTagFilters((prev) => prev.filter((tg) => tg !== tag))
      try {
        await api('/workflows/tags/delete', { method: 'POST', body: JSON.stringify({ tag }) })
        addToast(t('workflowsDashboard.tagDeleted') as string, 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)))
        setTagOptions((prev) => (prev.includes(tag) ? prev : [...prev, tag].sort((a, b) => a.localeCompare(b, getResolvedLocale()))))
        setTagFilters((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
        addToast(tApiError(err) || (t('workflowsDashboard.deleteTagFailed') as string), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Toggle one row's checkbox in selection mode.
  const toggleSelected = useCallback((workflowId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(workflowId)) next.delete(workflowId)
      else next.add(workflowId)
      return next
    })
  }, [])

  // Select (or clear) every visible row at once. "All selected?" is recomputed
  // INSIDE the updater against `prev` so a rapid double-click can't act on a
  // stale snapshot.
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const all = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id))
      return all ? new Set<string>() : new Set(visibleIds)
    })
  }, [visibleIds])

  // Select-or-clear all rows in one folder section, leaving other sections'
  // selections untouched (add the folder's ids if not all are ticked, else
  // remove just them).
  const toggleSelectFolder = useCallback((items: SavedWorkflow[]) => {
    const ids = items.map((w) => w.id)
    setSelectedIds((prev) => {
      const all = ids.length > 0 && ids.every((id) => prev.has(id))
      const next = new Set(prev)
      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])

  // Move every selected workflow into `folder` (null = Ungrouped) in one request.
  // Optimistic: re-fold the selected rows locally (capturing each prior folder for
  // an exact rollback), POST the bulk route, bump + toast + clear on success, roll
  // back on failure.
  const bulkAssign = useCallback(
    async (folder: string | null) => {
      const ids = [...selectedIds]
      if (ids.length === 0) return
      const idSet = new Set(ids)
      const priorFolders = new Map(
        workflows.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.folder ?? null]),
      )

      setWorkflows((prev) => prev.map((w) => (idSet.has(w.id) ? { ...w, folder } : w)))
      setSelectedIds(new Set())
      setSelectionMode(false)
      setBulkFolderDraft('')
      try {
        const result = (await api('/workflows/folders/assign', {
          method: 'POST',
          body: JSON.stringify({ workflowIds: ids, folder }),
        })) as { count?: number }
        const count = typeof result?.count === 'number' ? result.count : ids.length
        addToast(
          folder
            ? (t('workflowsDashboard.bulkMoved', { folder, count }) as string)
            : (t('workflowsDashboard.bulkMovedUngrouped', { count }) as string),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (priorFolders.has(w.id) ? { ...w, folder: priorFolders.get(w.id) ?? null } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.bulkMoveFailed') as string), 'error')
      }
    },
    [selectedIds, workflows, addToast, bumpPlatformVersion, t],
  )

  // Add or remove one tag across every selected workflow in a single request.
  // Optimistic: re-tag the selected rows locally (add → union+dedupe, remove →
  // filter), capturing each prior tag array for an exact rollback, then POST the
  // bulk route. Tags are multi-value, so unlike `bulkAssign` (one folder) this
  // unions/filters rather than replacing.
  const bulkAssignTag = useCallback(
    async (op: 'add' | 'remove') => {
      const ids = [...selectedIds]
      const tag = bulkTagDraft.trim()
      if (ids.length === 0 || !tag) return
      const idSet = new Set(ids)
      const priorTags = new Map(
        workflows.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.tags ?? []]),
      )

      setWorkflows((prev) =>
        prev.map((w) => {
          if (!idSet.has(w.id)) return w
          const current = w.tags ?? []
          const tags =
            op === 'add'
              ? current.includes(tag) ? current : [...current, tag]
              : current.filter((t) => t !== tag)
          return { ...w, tags }
        }),
      )
      setSelectedIds(new Set())
      setSelectionMode(false)
      setBulkTagDraft('')
      try {
        const result = (await api('/workflows/tags/assign', {
          method: 'POST',
          body: JSON.stringify({ workflowIds: ids, tag, op }),
        })) as { count?: number }
        const count = typeof result?.count === 'number' ? result.count : ids.length
        addToast(
          op === 'add'
            ? (t('workflowsDashboard.bulkTagAdded', { tag, count }) as string)
            : (t('workflowsDashboard.bulkTagRemoved', { tag, count }) as string),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.bulkTagFailed') as string), 'error')
      }
    },
    [selectedIds, bulkTagDraft, workflows, addToast, bumpPlatformVersion, t],
  )

  const renderRow = (workflow: SavedWorkflow) => {
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
    <li key={workflow.id}>
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
        {selectionMode && (
          <input
            type="checkbox"
            className="we-list-row__select"
            checked={selectedIds.has(workflow.id)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => { event.stopPropagation(); toggleSelected(workflow.id) }}
            aria-label={t('workflowsDashboard.selectRowAria', { name: workflow.name }) as string}
            data-testid={`workflows-select-row-${workflow.id}`}
          />
        )}
        {/* Drag handle — only rendered once folders exist (otherwise there's no
            section to drop onto). Native DnD is mouse-only; the per-row select
            below and the Inspector folder field stay keyboard-accessible. */}
        {hasFolders && (
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
            title={t('workflowsDashboard.dragHandleTitle') as string}
            aria-label={t('workflowsDashboard.dragHandleTitle') as string}
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
                <span key={tag} className="we-pill we-pill--ghost we-list-row__tag">
                  {tag}
                  <button
                    type="button"
                    className="we-list-row__tag-remove"
                    aria-label={t('workflowsDashboard.removeTagAria', { tag }) as string}
                    title={t('workflowsDashboard.removeTagAria', { tag }) as string}
                    onClick={(event) => { event.stopPropagation(); void setRowTag(workflow.id, tag, 'remove') }}
                    data-testid={`workflows-row-tag-remove-${workflow.id}-${tag}`}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {addableTags.length > 0 && (
                <select
                  className="we-list-row__tag-add"
                  value=""
                  aria-label={t('workflowsDashboard.addTagAria', { name: workflow.name }) as string}
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
              <span className="we-pill we-pill--ghost" title={t('workflowsDashboard.inFolder', { folder: workflow.folder }) as string}>
                <Folder size={12} aria-hidden="true" /> {workflow.folder}
              </span>
            </span>
          )}
        </div>
        <div className="we-list-row__meta">
          {workflow.lastRunStatus && (
            <span className="status-pill" data-status={workflow.lastRunStatus}>{formatStatusLabel(workflow.lastRunStatus)}</span>
          )}
          {typeof workflow.runCount === 'number' && (
            <span className="we-list-row__count" title={t('workflowsDashboard.runCountTitle', { count: workflow.runCount }) as string}>{workflow.runCount}</span>
          )}
          <WorkflowHealthBadge workflowId={workflow.id} showLabel={false} />
          {/* Keyboard / screen-reader equivalent of drag-to-folder: a native
              <select> is operable without a mouse. Only rendered once folders
              exist (same gate as the drag handle), so the flat no-folder list is
              unchanged. Reuses the same moveToFolder path the drag drop uses. */}
          {hasFolders && (
            <select
              className="we-list-row__folder-select"
              value={workflow.folder ?? ''}
              aria-label={t('workflowsDashboard.moveToFolderAria', { name: workflow.name }) as string}
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
          <button onClick={(event) => { event.stopPropagation(); onOpen(workflow.id) }} className="small-command">{t('workflowsDashboard.openFlow')}</button>
        </div>
      </div>
    </li>
    )
  }

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

      {showToolbar && (
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
      )}

      {selectionMode && selectedIds.size > 0 && (
        <div className="we-list-bulk-bar" data-testid="workflows-bulk-bar">
          <span className="we-list-bulk-bar__count">{t('workflowsDashboard.bulkSelectedCount', { count: selectedIds.size })}</span>
          <input
            className="text-field we-list-bulk-bar__input"
            list="we-bulk-folder-options"
            value={bulkFolderDraft}
            maxLength={60}
            onChange={event => setBulkFolderDraft(event.target.value)}
            placeholder={t('workflowsDashboard.bulkFolderPlaceholder') as string}
            aria-label={t('workflowsDashboard.bulkFolderPlaceholder') as string}
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
            placeholder={t('workflowsDashboard.bulkTagPlaceholder') as string}
            aria-label={t('workflowsDashboard.bulkTagPlaceholder') as string}
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

      {workflows.length === 0 && !loading && folderFilter !== '' && (
        <p className="helper-text" data-testid="workflows-no-folder-matches">
          {t('workflowsDashboard.noFolderMatches', { folder: folderFilter })}
        </p>
      )}

      {workflows.length === 0 && !loading && folderFilter === '' && tagFilters.length > 0 && (
        <p className="helper-text" data-testid="workflows-no-tag-matches">
          {t('workflowsDashboard.noTagMatches', { tags: tagFilters.join(', ') })}
        </p>
      )}

      {workflows.length === 0 && !loading && folderFilter === '' && tagFilters.length === 0 && (
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

      {visible.length > 0 && !hasFolders && (
        <ul className="we-list">
          {visible.map(renderRow)}
        </ul>
      )}

      {visible.length > 0 && hasFolders && (
        <div className="we-list-folders" data-testid="workflows-folder-groups">
          {groups.map(group => {
            const label = group.key === UNGROUPED ? (t('workflowsDashboard.ungroupedFolder') as string) : group.key
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
                <summary className="we-list-folder__summary">
                  {renamingFolder === group.key ? (
                    // Inline rename: the controls preventDefault so a click never
                    // toggles the <details>; Enter saves, Esc cancels.
                    <span className="we-list-folder__rename" onClick={event => { event.preventDefault(); event.stopPropagation() }}>
                      <input
                        className="text-field we-list-folder__rename-input"
                        value={renameDraft}
                        autoFocus
                        maxLength={60}
                        aria-label={t('workflowsDashboard.renameFolderLabel') as string}
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
                      {selectionMode && (
                        <button
                          type="button"
                          className="small-command we-list-folder__selectall"
                          aria-pressed={group.items.every((w) => selectedIds.has(w.id))}
                          onClick={event => { event.preventDefault(); event.stopPropagation(); toggleSelectFolder(group.items) }}
                          title={t('workflowsDashboard.selectAllInFolderAria', { folder: label }) as string}
                          aria-label={t('workflowsDashboard.selectAllInFolderAria', { folder: label }) as string}
                          data-testid={`workflows-select-folder-${group.key === UNGROUPED ? 'ungrouped' : group.key}`}
                        >
                          <ListChecks size={12} aria-hidden="true" />
                        </button>
                      )}
                      <span className="we-list-folder__name">{label}</span>
                      <span className="we-pill we-pill--ghost">{t('workflowsDashboard.folderCount', { count: group.items.length })}</span>
                      {/* Rename / delete only for NAMED folders — "Ungrouped" is a
                          synthetic bucket, not a real folder to manage. */}
                      {group.key !== UNGROUPED && (
                        <span className="we-list-folder__actions">
                          <button
                            type="button"
                            className="small-command"
                            onClick={event => { event.preventDefault(); event.stopPropagation(); setConfirmDeleteFolder(null); setRenameDraft(group.key); setRenamingFolder(group.key) }}
                            title={t('workflowsDashboard.renameFolder', { folder: group.key }) as string}
                            aria-label={t('workflowsDashboard.renameFolder', { folder: group.key }) as string}
                            data-testid={`workflows-renamefolder-${group.key}`}
                          >
                            <Pencil size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="small-command danger"
                            onClick={event => { event.preventDefault(); event.stopPropagation(); setRenamingFolder(null); setConfirmDeleteFolder(group.key) }}
                            title={t('workflowsDashboard.deleteFolder', { folder: group.key }) as string}
                            aria-label={t('workflowsDashboard.deleteFolder', { folder: group.key }) as string}
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
                placeholder={t('workflowsDashboard.newFolderPlaceholder') as string}
                aria-label={t('workflowsDashboard.newFolderLabel') as string}
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
    </div>
  )
}
