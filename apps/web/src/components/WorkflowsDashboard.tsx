/**
 * Saved-workflows list — calls `/workflows` and renders each as an
 * openable row. Re-fetches on `platformVersion` changes (cross-panel
 * reactivity hook from AGENTS.md).
 *
 * Used by `RightPanel.tsx` (the `workflows` tab).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoadingSkeleton } from './LoadingSkeleton'
import { CircleCheck, FolderPlus, ListChecks, Pencil, RefreshCw, Trash, Trash2, Workflow } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { readFlowsFilters, writeFlowsFilters, type SortKey } from '../flows-filters'
import { FlowRow } from './FlowRow'
import { FlowsFilterBar } from './FlowsFilterBar'
import { TrashPanel } from './TrashPanel'

/** Run statuses that count as "failed" for the failed-first sort (mirrors
 *  the server's terminal-failure set). */
const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled', 'timed_out'])
const STATUS_PAUSED_CIRCUIT_BREAKER = 'paused_circuit_breaker'

/** Flows-list page size — the initial load and each "Load more" page fetch this
 *  many rows. A full page (`=== PAGE_SIZE`) means another page may exist; a short
 *  page ends pagination. Matches the server list default so a bare first load is
 *  unchanged. Kept ≤ the route's 200 cap. */
const PAGE_SIZE = 100

/** Sentinel key for the "Ungrouped" folder section. A real folder name is
 *  `min(1)` chars, so the empty string can never collide with one. */
const UNGROUPED = ''

/** Fallback retention window (days) for the Trash "expires in N days" label,
 *  used only when `GET /org/config` succeeds but the org left
 *  `retention.deletedWorkflowsDays` unset. Mirrors the backend default — if the
 *  server default changes, update this one spot. The actual purge always runs
 *  server-side; this is a display estimate. */
const DEFAULT_RETENTION_DAYS = 30

/** One Flows-list folder section: the folder key (`UNGROUPED` = no folder) and
 *  its workflows, in the same order the global filter+sort produced. */
type FolderGroup = { key: string; items: SavedWorkflow[] }

/** Return the persisted collapsed-folder set after a details section reaches
 *  `open`. Reuses the current array for no-op native toggle notifications. */
function updateCollapsedFolders(current: string[], key: string, open: boolean): string[] {
  const collapsed = current.includes(key)
  if (open && collapsed) return current.filter((entry) => entry !== key)
  if (!open && !collapsed) return [...current, key]
  return current
}

/** Render the saved-workflows list with click-to-open + manual refresh. */
export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)
  const recoveryBusyRef = useRef(new Set<string>())
  const [recoveryBusyIds, setRecoveryBusyIds] = useState<Set<string>>(() => new Set())
  // "Load more" keyset pagination. `hasMore` is true when the last page came back
  // full (so another page may exist); `loadingMore` guards the in-flight append.
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
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
  // Debounced mirror of `query` that drives the SERVER-side search refetch. The
  // instant client-side filter keys off `query` (no lag while typing); the
  // server fetch waits for typing to settle so a beyond-cap name match
  // back-fills without a request per keystroke. Initialized to the restored
  // `query` so the first load already carries the persisted search term.
  const [debouncedQuery, setDebouncedQuery] = useState(() => readFlowsFilters()?.query ?? '')
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
  // Native <details> emits `toggle` asynchronously. Track click intent outside
  // React state so a second click or immediate reload observes the latest value
  // even before the first toggle event commits.
  const collapsedFoldersRef = useRef(collapsedFolders)
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
  // Trash view. `showTrashed` swaps the list to the soft-deleted workflows
  // (`GET /workflows/trash`) — a flat, filter-free, Restore-only list (active-
  // only affordances like folders/tags/bulk are hidden there). `confirmDeleteId`
  // is the active-view row awaiting a delete confirm (inline, one at a time).
  const [showTrashed, setShowTrashed] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // Org retention window (days) for the Trash "expires in N days" label. `null`
  // = unknown (not yet fetched or the fetch failed) → render no expiry label,
  // never a guessed number. Loaded from GET /org/config when Trash is opened.
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  // Timestamp captured when the Trash retention window is loaded. Kept in state
  // so row rendering stays pure (no Date.now() reads during render).
  const [trashNowMs, setTrashNowMs] = useState<number | null>(null)
  // Monotonic list request id. Active-list and Trash fetches share the same
  // `workflows` state; when the operator toggles views while an older request is
  // still in flight, only the newest response may paint rows.
  const listRequestSeq = useRef(0)

  // Shared query-string for the list fetch — the active tag / folder / search
  // filters. Both the initial load and "Load more" use it, so the cursor always
  // pages within exactly the filtered set. No explicit `limit`: the server
  // defaults to PAGE_SIZE, which is what the hasMore inference compares against.
  const buildListParams = useCallback(() => {
    const params = new URLSearchParams()
    // Repeated `?tag=` params — the server ANDs them.
    tagFilters.forEach(tag => params.append('tag', tag))
    if (folderFilter) params.set('folder', folderFilter)
    // `?q=` name/id search (server-side, before the cap) — debounced so a
    // beyond-cap match back-fills once typing settles.
    const trimmedQuery = debouncedQuery.trim()
    if (trimmedQuery) params.set('q', trimmedQuery)
    return params
  }, [tagFilters, folderFilter, debouncedQuery])

  const load = useCallback(async () => {
    const requestSeq = listRequestSeq.current + 1
    listRequestSeq.current = requestSeq
    setLoading(true)
    try {
      // Trash is a flat, filter-free read (no tag/folder/search params); the
      // active list keeps its filters. Both keyset-paginate (trash on deletedAt,
      // active on createdAt — see loadMore).
      const qs = showTrashed ? '' : buildListParams().toString()
      const base = showTrashed ? '/workflows/trash' : '/workflows'
      const data = await api(`${base}${qs ? `?${qs}` : ''}`)
      if (listRequestSeq.current !== requestSeq) return
      const page = Array.isArray(data) ? (data as SavedWorkflow[]) : []
      setWorkflows(page)
      // A full page means another may exist; a short page ends pagination.
      setHasMore(page.length === PAGE_SIZE)
    } catch (error) {
      if (listRequestSeq.current !== requestSeq) return
      addToast(error instanceof Error ? error.message : t('workflowsDashboard.toastFailed'), 'error')
    } finally {
      if (listRequestSeq.current === requestSeq) setLoading(false)
    }
  }, [addToast, t, buildListParams, showTrashed])

  // Append the next keyset page after the oldest loaded row. `workflows` is in
  // server order, so its last element is the global oldest. The cursor instant is
  // the row's `deletedAt` in Trash (ordered deletedAt DESC) or `createdAt` in the
  // active list (createdAt DESC); URLSearchParams encodes the `|`.
  const loadMore = useCallback(async () => {
    if (loadingMore) return
    const oldest = workflows[workflows.length - 1]
    const cursorTs = showTrashed ? oldest?.deletedAt : oldest?.createdAt
    if (!oldest || !cursorTs) return
    const requestSeq = listRequestSeq.current
    setLoadingMore(true)
    try {
      // Trash pages the filter-free /workflows/trash; the active list threads its
      // tag/folder/search filters so paging stays within the filtered set.
      const params = showTrashed ? new URLSearchParams() : buildListParams()
      params.set('before', `${cursorTs}|${oldest.id}`)
      const base = showTrashed ? '/workflows/trash' : '/workflows'
      const data = await api(`${base}?${params.toString()}`)
      if (listRequestSeq.current !== requestSeq) return
      const page = Array.isArray(data) ? (data as SavedWorkflow[]) : []
      setWorkflows(prev => [...prev, ...page])
      setHasMore(page.length === PAGE_SIZE)
    } catch (error) {
      if (listRequestSeq.current === requestSeq) {
        addToast(error instanceof Error ? error.message : t('workflowsDashboard.toastFailed'), 'error')
      }
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, workflows, buildListParams, showTrashed, addToast, t])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  // Settle `query` into `debouncedQuery` ~300ms after the last keystroke so the
  // server search fires once per pause, not per character. The cleanup cancels a
  // pending settle on each change, so rapid typing coalesces to one refetch.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(id)
  }, [query])

  // Persist the tag / folder / search / sort / collapsed-folders view before
  // the browser paints the committed state. In particular, this closes the
  // window where an operator can collapse a section and immediately reload
  // before a deferred effect has written the new preference.
  useLayoutEffect(() => {
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

  // The org's retention window for the Trash "expires in N days" label. Only
  // fetched when Trash is open (the label is trash-only), via the un-gated
  // GET /org/config. A finite `retention.deletedWorkflowsDays` is used directly;
  // an unset key falls back to the backend default; a fetch failure leaves
  // `retentionDays` null so no (possibly-wrong) number is shown. Non-fatal.
  useEffect(() => {
    if (!showTrashed) {
      setRetentionDays(null)
      setTrashNowMs(null)
      return
    }
    let cancelled = false
    const openedAtMs = Date.now()
    setRetentionDays(null)
    setTrashNowMs(openedAtMs)
    void (async () => {
      try {
        const payload = await api('/org/config')
        const envelope = payload as { config?: unknown }
        const entries = (Array.isArray(payload)
          ? payload
          : Array.isArray(envelope.config)
            ? envelope.config
            : []) as Array<{ key: string; value: unknown }>
        const raw = entries.find(entry => entry.key === 'retention.deletedWorkflowsDays')?.value
        if (cancelled) return
        const parsed = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_RETENTION_DAYS
        setRetentionDays(parsed)
      } catch {
        // Unknown window → leave null so the row shows no expiry estimate.
        if (!cancelled) setRetentionDays(null)
      }
    })()
    return () => { cancelled = true }
  }, [showTrashed, platformVersion])

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

  // Whether ANY of the three stackable filters (search / tags / folder) is
  // active — gates the "Clear filters" reset. Sort, collapsed sections, and
  // selection mode are NOT filters and are intentionally excluded.
  const hasActiveFilters = query.trim() !== '' || tagFilters.length > 0 || folderFilter !== ''

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

  const persistCollapsedFolders = useCallback((nextCollapsed: string[]) => {
    collapsedFoldersRef.current = nextCollapsed
    writeFlowsFilters({ tags: tagFilters, folder: folderFilter, query, sort, collapsedFolders: nextCollapsed })
  }, [folderFilter, query, sort, tagFilters])

  const toggleFolder = useCallback((key: string, open: boolean) => {
    const current = collapsedFoldersRef.current
    const nextCollapsed = updateCollapsedFolders(current, key, open)
    if (nextCollapsed !== current) persistCollapsedFolders(nextCollapsed)
    // A preceding summary click may already have persisted the intent, but the
    // later native toggle still owns reconciliation into controlled React state.
    setCollapsedFolders(nextCollapsed)
  }, [persistCollapsedFolders])

  // Reset the three stackable filters (search / tags / folder) in one click.
  // `debouncedQuery` is reset alongside `query` so the unfiltered refetch fires
  // immediately instead of after the search debounce settles; the four setStates
  // batch into a single `load` refetch. Sort / collapsed sections / selection
  // mode are deliberately left untouched (they aren't filters).
  const clearAllFilters = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
    setTagFilters([])
    setFolderFilter('')
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
            ? (t('workflowsDashboard.movedToFolder', { folder }))
            : (t('workflowsDashboard.movedToUngrouped')),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (w.id === workflowId ? { ...w, folder: previousFolder } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.moveFailed')), 'error')
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
            ? (t('workflowsDashboard.rowTagAdded', { tag }))
            : (t('workflowsDashboard.rowTagRemoved', { tag })),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, tags: prior } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.rowTagFailed')), 'error')
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
        addToast(t('workflowsDashboard.folderRenamed', { folder: trimmed }), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder: from } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.renameFailed')), 'error')
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
        addToast(t('workflowsDashboard.folderDeleted'), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (affectedIds.has(w.id) ? { ...w, folder } : w)))
        addToast(tApiError(err) || (t('workflowsDashboard.folderDeleteFailed')), 'error')
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
        addToast(t('workflowsDashboard.tagRenamed', { tag: trimmed }), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)))
        setTagOptions((prev) => {
          const next = prev.filter((tg) => tg !== trimmed)
          if (!next.includes(from)) next.push(from)
          return next.sort((a, b) => a.localeCompare(b, getResolvedLocale()))
        })
        setTagFilters((prev) => [...new Set(prev.map((tg) => (tg === trimmed ? from : tg)))])
        addToast(tApiError(err) || (t('workflowsDashboard.renameTagFailed')), 'error')
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
        addToast(t('workflowsDashboard.tagDeleted'), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)))
        setTagOptions((prev) => (prev.includes(tag) ? prev : [...prev, tag].sort((a, b) => a.localeCompare(b, getResolvedLocale()))))
        setTagFilters((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
        addToast(tApiError(err) || (t('workflowsDashboard.deleteTagFailed')), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Resume a breaker pause or drain the next capped buffered page from an
  // already-active workflow. The per-row lock prevents duplicate production
  // continuations while either request is in flight.
  const resumeWorkflow = useCallback(
    async (workflowId: string) => {
      if (recoveryBusyRef.current.has(workflowId)) return
      const prior = workflows.find((w) => w.id === workflowId)
      if (!prior) return
      recoveryBusyRef.current.add(workflowId)
      setRecoveryBusyIds((current) => new Set(current).add(workflowId))
      const wasPausedByBreaker = prior.status === STATUS_PAUSED_CIRCUIT_BREAKER
      setWorkflows((prev) =>
        prev.map((w) => (w.id === workflowId ? { ...w, status: 'active', pausedReason: null } : w)),
      )
      try {
        const res = await api<{ backfilled?: number; remaining?: number }>(
          `/workflows/${encodeURIComponent(workflowId)}/resume`,
          { method: 'POST' },
        )
        // Say what actually happened to the events the pause held. "Resumed"
        // alone leaves the operator guessing whether the webhooks that arrived
        // during the outage were replayed or dropped.
        const backfilled = res?.backfilled ?? 0
        const remaining = res?.remaining ?? 0
        setWorkflows((prev) => prev.map((w) => (
          w.id === workflowId ? { ...w, bufferedTriggerCount: remaining } : w
        )))
        addToast(
          wasPausedByBreaker
            ? remaining > 0
              ? t('workflowsDashboard.resumedWithRemaining', { count: backfilled, remaining })
              : backfilled > 0
                ? t('workflowsDashboard.resumedWithBackfill', { count: backfilled })
                : t('workflowsDashboard.resumed')
            : remaining > 0
              ? t('workflowsDashboard.backfillWithRemaining', { count: backfilled, remaining })
              : t('workflowsDashboard.backfillCompleted', { count: backfilled }),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (w.id === workflowId && prior
            ? { ...w, status: prior.status, pausedReason: prior.pausedReason }
            : w)),
        )
        addToast(tApiError(err) || t('workflowsDashboard.resumeFailed'), 'error')
      } finally {
        recoveryBusyRef.current.delete(workflowId)
        setRecoveryBusyIds((current) => {
          const next = new Set(current)
          next.delete(workflowId)
          return next
        })
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
            ? (t('workflowsDashboard.bulkMoved', { folder, count }))
            : (t('workflowsDashboard.bulkMovedUngrouped', { count })),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (priorFolders.has(w.id) ? { ...w, folder: priorFolders.get(w.id) ?? null } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.bulkMoveFailed')), 'error')
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
            ? (t('workflowsDashboard.bulkTagAdded', { tag, count }))
            : (t('workflowsDashboard.bulkTagRemoved', { tag, count })),
          'success',
        )
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) =>
          prev.map((w) => (priorTags.has(w.id) ? { ...w, tags: priorTags.get(w.id) ?? [] } : w)),
        )
        addToast(tApiError(err) || (t('workflowsDashboard.bulkTagFailed')), 'error')
      }
    },
    [selectedIds, bulkTagDraft, workflows, addToast, bumpPlatformVersion, t],
  )

  // Soft-delete a workflow from the active list. Optimistic: drop the row
  // immediately (it moves to Trash), DELETE the workflow, then bump so other
  // panels refresh. Roll the row back on failure. The delete is recoverable
  // (restore from Trash within the retention window), so this is low-risk — and
  // it's behind an inline confirm.
  const deleteWorkflow = useCallback(
    async (workflowId: string) => {
      setConfirmDeleteId(null)
      const current = workflows.find((w) => w.id === workflowId)
      if (!current) return
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId))
      // Drop the id from the selection too (mirrors restoreWorkflow) so the bulk
      // bar can't show a stale count or act on an id no longer in the list.
      setSelectedIds((prev) => {
        if (!prev.has(workflowId)) return prev
        const next = new Set(prev)
        next.delete(workflowId)
        return next
      })
      try {
        await api(`/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })
        addToast(t('workflowsDashboard.workflowDeleted', { name: current.name }), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => (prev.some((w) => w.id === workflowId) ? prev : [current, ...prev]))
        addToast(tApiError(err) || (t('workflowsDashboard.deleteFailed')), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Restore a soft-deleted workflow from the Trash view. Optimistic: drop the
  // row from the trash list (it returns to the active list), POST restore, then
  // bump. Roll the row back on failure.
  const restoreWorkflow = useCallback(
    async (workflowId: string) => {
      const current = workflows.find((w) => w.id === workflowId)
      if (!current) return
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId))
      setSelectedIds((prev) => {
        if (!prev.has(workflowId)) return prev
        const next = new Set(prev)
        next.delete(workflowId)
        return next
      })
      try {
        await api(`/workflows/${encodeURIComponent(workflowId)}/restore`, { method: 'POST' })
        addToast(t('workflowsDashboard.workflowRestored', { name: current.name }), 'success')
        bumpPlatformVersion()
      } catch (err) {
        setWorkflows((prev) => (prev.some((w) => w.id === workflowId) ? prev : [current, ...prev]))
        addToast(tApiError(err) || (t('workflowsDashboard.restoreFailed')), 'error')
      }
    },
    [workflows, addToast, bumpPlatformVersion, t],
  )

  // Restore every checked trash row in one action. Optimistic: drop the selected
  // rows immediately, then fire the per-id restore route for each (the trash set
  // is retention-bounded, so the loop is small — no batch endpoint needed). A
  // partial failure surfaces an error toast; the bump-driven refetch reconciles,
  // so a row that failed to restore reappears in the trash list.
  const bulkRestore = useCallback(
    async () => {
      const ids = [...selectedIds].filter((id) => workflows.some((w) => w.id === id))
      if (ids.length === 0) return
      const idSet = new Set(ids)
      setWorkflows((prev) => prev.filter((w) => !idSet.has(w.id)))
      setSelectedIds(new Set())
      const results = await Promise.allSettled(
        ids.map((id) => api(`/workflows/${encodeURIComponent(id)}/restore`, { method: 'POST' })),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      if (ok > 0) addToast(t('workflowsDashboard.bulkRestored', { count: ok }), 'success')
      if (ok < ids.length) addToast(t('workflowsDashboard.bulkRestoreFailed'), 'error')
      bumpPlatformVersion()
    },
    [selectedIds, workflows, addToast, bumpPlatformVersion, t],
  )

  // Render one active-list row via the extracted <FlowRow>. Kept as a local
  // renderer so both call sites (the flat list and each folder section) stay a
  // bare `.map(renderRow)`; the container owns the state + mutations FlowRow
  // needs and threads them through here.
  const renderRow = (workflow: SavedWorkflow) => (
    <FlowRow
      key={workflow.id}
      workflow={workflow}
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
          {/* Trash toggle — always reachable (it lives in the always-rendered
              header, not the filterable toolbar). Entering Trash clears any
              active-view selection + delete-confirm so the views don't bleed. */}
          <button
            type="button"
            className="small-command"
            aria-pressed={showTrashed}
            onClick={() => {
              setShowTrashed((on) => !on)
              setSelectionMode(false)
              setSelectedIds(new Set())
              setConfirmDeleteId(null)
              // Clear the prior view's rows + show loading so they never paint
              // under the new view through the wrong row template (active rows as
              // trash with a Restore button, or vice versa) during the swap's
              // fetch. The view-keyed load() below repopulates.
              setWorkflows([])
              setLoading(true)
            }}
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

      {showToolbar && !showTrashed && (
        <FlowsFilterBar
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

      {!showTrashed && selectionMode && selectedIds.size > 0 && (
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

      {/* Trash view — a flat, filter-free list of soft-deleted workflows (uses
          the raw server-ordered `workflows`, NOT `visible`, so a stale active-
          view search term never filters it). Restore-only; no folders/tags/bulk. */}
      {showTrashed && (
        <TrashPanel
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
      {!showTrashed && visible.length === 0 && !loading && (
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
          <div className="we-allclear" data-testid="workflows-empty">
            <span className="we-allclear__ring" aria-hidden="true"><CircleCheck size={18} /></span>
            <div className="we-allclear__copy">
              <strong>{t('workflowsDashboard.empty')}</strong>
              <span>{t('workflowsDashboard.emptyHelper')}</span>
            </div>
          </div>
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
                    const current = collapsedFoldersRef.current
                    const nextCollapsed = updateCollapsedFolders(current, group.key, !details.open)
                    if (nextCollapsed !== current) persistCollapsedFolders(nextCollapsed)
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
                      {selectionMode && (
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
                      {group.key !== UNGROUPED && (
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
