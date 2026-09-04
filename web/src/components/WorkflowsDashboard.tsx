/** Saved workflow inventory controller with server-backed filtering and optimistic organization. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { WorkflowsDashboardView } from './WorkflowsDashboardView'
import {
  UNGROUPED_FOLDER,
  updateCollapsedFolders,
} from './workflows-dashboard-model'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { SavedWorkflow } from '../types'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { readFlowsFilters, writeFlowsFilters, type SortKey } from '../flows-filters'
import {
  activeTextSearch,
  classifyTextSearch,
  TEXT_SEARCH_MAX_CHARACTERS,
  TEXT_SEARCH_MIN_INDEXABLE_CHARACTERS,
} from '../lib/text-search'
import { orgConfigValue } from '../lib/org-config-model'

const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled', 'timed_out'])
const STATUS_PAUSED_CIRCUIT_BREAKER = 'paused_circuit_breaker'

const PAGE_SIZE = 100

const UNGROUPED = UNGROUPED_FOLDER

const DEFAULT_RETENTION_DAYS = 30

type FolderGroup = { key: string; items: SavedWorkflow[] }

export type WorkflowCreationMode = 'describe' | 'blank' | 'template'
export type WorkflowsDashboardProps = {
  onOpen: (id: string) => void
  onCreate?: (mode: WorkflowCreationMode) => void
  canWrite?: boolean
}
function useWorkflowsDashboardController({
  onOpen,
  onCreate,
  canWrite = true,
}: WorkflowsDashboardProps) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  // Callbacks read the latest list through a ref, so an optimistic edit
  // (which replaces `workflows`) does not recreate every handler and the
  // controller model along with it. (Guarded ref write during render: idempotent.)
  const workflowsRef = useRef(workflows)
  workflowsRef.current = workflows
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creationOpen, setCreationOpen] = useState(false)
  const recoveryBusyRef = useRef(new Set<string>())
  const [recoveryBusyIds, setRecoveryBusyIds] = useState<Set<string>>(() => new Set())
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [newFolderHover, setNewFolderHover] = useState(false)
  const [newFolderDropFor, setNewFolderDropFor] = useState<string | null>(null)
  const [newFolderDraft, setNewFolderDraft] = useState('')
  const [query, setQuery] = useState(() => readFlowsFilters()?.query ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(() => activeTextSearch(readFlowsFilters()?.query ?? ''))
  const [sort, setSort] = useState<SortKey>(() => readFlowsFilters()?.sort ?? 'recent')
  const [tagFilters, setTagFilters] = useState<string[]>(() => readFlowsFilters()?.tags ?? [])
  const [tagOptions, setTagOptions] = useState<string[]>([])
  const [folderFilter, setFolderFilter] = useState(() => readFlowsFilters()?.folder ?? '')
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(
    () => readFlowsFilters()?.collapsedFolders ?? [],
  )
  const collapsedFoldersRef = useRef(collapsedFolders)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null)
  const [renamingTag, setRenamingTag] = useState(false)
  const [tagRenameDraft, setTagRenameDraft] = useState('')
  const [confirmDeleteTag, setConfirmDeleteTag] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkFolderDraft, setBulkFolderDraft] = useState('')
  const [bulkTagDraft, setBulkTagDraft] = useState('')
  const [showTrashed, setShowTrashed] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [trashNowMs, setTrashNowMs] = useState<number | null>(null)
  const listRequestSeq = useRef(0)
  const queryState = useMemo(() => classifyTextSearch(query), [query])
  const searchHint = queryState.kind === 'too-short'
    ? t('apiErrors.search_query_too_short', { minChars: TEXT_SEARCH_MIN_INDEXABLE_CHARACTERS })
    : queryState.kind === 'too-long'
      ? t('apiErrors.search_query_too_long', { maxChars: TEXT_SEARCH_MAX_CHARACTERS })
      : queryState.kind === 'invalid-characters'
        ? t('apiErrors.search_query_invalid_characters')
        : null
  const searchInvalid = queryState.kind === 'too-long' || queryState.kind === 'invalid-characters'
  const buildListParams = useCallback(() => {
    const params = new URLSearchParams()
    tagFilters.forEach(tag => params.append('tag', tag))
    if (folderFilter) params.set('folder', folderFilter)
    if (debouncedQuery) params.set('q', debouncedQuery)
    return params
  }, [tagFilters, folderFilter, debouncedQuery])
  const load = useCallback(async () => {
    const requestSeq = listRequestSeq.current + 1
    listRequestSeq.current = requestSeq
    setLoading(true)
    setLoadError(null)
    try {
      const qs = showTrashed ? '' : buildListParams().toString()
      const base = showTrashed ? '/workflows/trash' : '/workflows'
      const data = await api(`${base}${qs ? `?${qs}` : ''}`)
      if (listRequestSeq.current !== requestSeq) return
      const page = Array.isArray(data) ? (data as SavedWorkflow[]) : []
      setWorkflows(page)
      setHasMore(page.length === PAGE_SIZE)
    } catch (error) {
      if (listRequestSeq.current !== requestSeq) return
      const message = error instanceof Error ? error.message : t('workflowsDashboard.toastFailed')
      setLoadError(message)
      addToast(message, 'error')
    } finally {
      if (listRequestSeq.current === requestSeq) setLoading(false)
    }
  }, [addToast, t, buildListParams, showTrashed])
  const loadMore = useCallback(async () => {
    if (loadingMore) return
    const oldest = workflows[workflows.length - 1]
    const cursorTs = showTrashed ? oldest?.deletedAt : oldest?.createdAt
    if (!oldest || !cursorTs) return
    const requestSeq = listRequestSeq.current
    setLoadingMore(true)
    try {
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
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(activeTextSearch(query)), 300)
    return () => clearTimeout(id)
  }, [query])
  useLayoutEffect(() => {
    writeFlowsFilters({ tags: tagFilters, folder: folderFilter, query, sort, collapsedFolders })
  }, [tagFilters, folderFilter, query, sort, collapsedFolders])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api('/workflows/tags') as { tags?: unknown }
        const tags = Array.isArray(data?.tags) ? (data.tags as string[]) : []
        if (cancelled) return
        setTagOptions(tags)
        setTagFilters(current => current.filter(tg => tags.includes(tg)))
      } catch {
        if (!cancelled) setTagOptions([])
      }
    })()
    return () => { cancelled = true }
  }, [platformVersion])
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
        const raw = orgConfigValue(payload, 'retention.deletedWorkflowsDays')
        if (cancelled) return
        const parsed = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_RETENTION_DAYS
        setRetentionDays(parsed)
      } catch {
        if (!cancelled) setRetentionDays(null)
      }
    })()
    return () => { cancelled = true }
  }, [showTrashed, platformVersion])
  const visible = useMemo(() => {
    const locale = getResolvedLocale()
    const q = queryState.kind === 'valid' ? queryState.value.toLocaleLowerCase(locale) : ''
    const filtered = q
      ? workflows.filter(w => w.name.toLocaleLowerCase(locale).includes(q) || w.id.toLocaleLowerCase(locale).includes(q))
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
  }, [workflows, queryState, sort])
  const visibleIds = useMemo(() => visible.map((w) => w.id), [visible])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const showToolbar =
    tagOptions.length > 0 ||
    folderOptions.length > 0 ||
    workflows.length > 1 ||
    tagFilters.length > 0 ||
    folderFilter !== '' ||
    query.trim() !== ''
  const soleTagFilter = tagFilters.length === 1 ? tagFilters[0] : undefined
  const hasActiveFilters = query.trim() !== '' || tagFilters.length > 0 || folderFilter !== ''
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
  const hasFolders = groups.some((group) => group.key !== UNGROUPED)
  const persistCollapsedFolders = useCallback((nextCollapsed: string[]) => {
    collapsedFoldersRef.current = nextCollapsed
    writeFlowsFilters({ tags: tagFilters, folder: folderFilter, query, sort, collapsedFolders: nextCollapsed })
  }, [folderFilter, query, sort, tagFilters])
  const toggleFolder = useCallback((key: string, open: boolean) => {
    const current = collapsedFoldersRef.current
    const nextCollapsed = updateCollapsedFolders(current, key, open)
    if (nextCollapsed !== current) persistCollapsedFolders(nextCollapsed)
    setCollapsedFolders(nextCollapsed)
  }, [persistCollapsedFolders])
  const rememberFolderToggle = useCallback((key: string, nextOpen: boolean) => {
    const current = collapsedFoldersRef.current
    const nextCollapsed = updateCollapsedFolders(current, key, nextOpen)
    if (nextCollapsed !== current) persistCollapsedFolders(nextCollapsed)
  }, [persistCollapsedFolders])
  const clearAllFilters = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
    setTagFilters([])
    setFolderFilter('')
  }, [])
  const moveToFolder = useCallback(
    async (workflowId: string, folderKey: string) => {
      const folder = folderKey === UNGROUPED ? null : folderKey
      const current = workflowsRef.current.find((w) => w.id === workflowId)
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
    [addToast, bumpPlatformVersion, t],
  )
  const setRowTag = useCallback(
    async (workflowId: string, tag: string, op: 'add' | 'remove') => {
      const current = workflowsRef.current.find((w) => w.id === workflowId)
      if (!current) return
      const prior = current.tags ?? []
      if (op === 'add' && prior.includes(tag)) return
      if (op === 'remove' && !prior.includes(tag)) return
      const next = op === 'add' ? [...prior, tag] : prior.filter((t) => t !== tag)
      setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, tags: next } : w)))
      try {
        await api(`/workflows/${encodeURIComponent(workflowId)}/tags`, {
          method: 'POST',
          // This route replaces the whole tag set; `next` is the intended
          // complete value, not a per-tag command.
          body: JSON.stringify({ tags: next }),
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
    [addToast, bumpPlatformVersion, t],
  )
  const commitNewFolder = useCallback(() => {
    const id = newFolderDropFor
    const name = newFolderDraft.trim()
    setNewFolderDropFor(null)
    setNewFolderDraft('')
    if (!id || !name) return
    void moveToFolder(id, name)
  }, [newFolderDropFor, newFolderDraft, moveToFolder])
  const cancelNewFolder = useCallback(() => {
    setNewFolderDropFor(null)
    setNewFolderDraft('')
  }, [])
  const renameFolder = useCallback(
    async (from: string, to: string) => {
      setRenamingFolder(null)
      const trimmed = to.trim()
      if (!trimmed || trimmed === from) return
      const affectedIds = new Set(workflowsRef.current.filter((w) => w.folder === from).map((w) => w.id))
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
    [addToast, bumpPlatformVersion, t],
  )
  const deleteFolder = useCallback(
    async (folder: string) => {
      setConfirmDeleteFolder(null)
      const affectedIds = new Set(workflowsRef.current.filter((w) => w.folder === folder).map((w) => w.id))
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
    [addToast, bumpPlatformVersion, t],
  )
  const renameTag = useCallback(
    async (from: string, to: string) => {
      setRenamingTag(false)
      const trimmed = to.trim()
      if (!trimmed || trimmed === from) return
      const idSet = new Set(workflowsRef.current.filter((w) => (w.tags ?? []).includes(from)).map((w) => w.id))
      const priorTags = new Map(workflowsRef.current.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.tags ?? []]))
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
    [addToast, bumpPlatformVersion, t],
  )
  const deleteTag = useCallback(
    async (tag: string) => {
      setConfirmDeleteTag(false)
      const idSet = new Set(workflowsRef.current.filter((w) => (w.tags ?? []).includes(tag)).map((w) => w.id))
      const priorTags = new Map(workflowsRef.current.filter((w) => idSet.has(w.id)).map((w) => [w.id, w.tags ?? []]))
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
    [addToast, bumpPlatformVersion, t],
  )
  const resumeWorkflow = useCallback(
    async (workflowId: string) => {
      if (recoveryBusyRef.current.has(workflowId)) return
      const prior = workflowsRef.current.find((w) => w.id === workflowId)
      if (!prior) return
      recoveryBusyRef.current.add(workflowId)
      setRecoveryBusyIds((current) => new Set(current).add(workflowId))
      const wasPausedByBreaker = prior.status === STATUS_PAUSED_CIRCUIT_BREAKER
      setWorkflows((prev) =>
        prev.map((w) => (w.id === workflowId ? { ...w, status: 'active', pausedReason: null } : w)),
      )
      try {
        const res = await api(
          `/workflows/${encodeURIComponent(workflowId)}/resume`,
          { method: 'POST' },
        ) as { backfilled?: number; remaining?: number }
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
    [addToast, bumpPlatformVersion, t],
  )
  const toggleSelected = useCallback((workflowId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(workflowId)) next.delete(workflowId)
      else next.add(workflowId)
      return next
    })
  }, [])
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const all = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id))
      return all ? new Set<string>() : new Set(visibleIds)
    })
  }, [visibleIds])
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
        })) as { affected?: number }
        const count = typeof result?.affected === 'number' ? result.affected : ids.length
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
          body: JSON.stringify({ workflowIds: ids, tag, remove: op === 'remove' }),
        })) as { affected?: number }
        const count = typeof result?.affected === 'number' ? result.affected : ids.length
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
  const deleteWorkflow = useCallback(
    async (workflowId: string) => {
      setConfirmDeleteId(null)
      const current = workflowsRef.current.find((w) => w.id === workflowId)
      if (!current) return
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId))
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
    [addToast, bumpPlatformVersion, t],
  )
  const restoreWorkflow = useCallback(
    async (workflowId: string) => {
      const current = workflowsRef.current.find((w) => w.id === workflowId)
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
    [addToast, bumpPlatformVersion, t],
  )
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
  const toggleTrashView = useCallback(() => {
    setShowTrashed((current) => !current)
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmDeleteId(null)
    setWorkflows([])
    setLoading(true)
  }, [])
  return {
    allVisibleSelected, bulkAssign, bulkAssignTag, bulkFolderDraft, bulkRestore, bulkTagDraft,
    canWrite, cancelNewFolder, clearAllFilters, collapsedFolders, commitNewFolder,
    confirmDeleteFolder, confirmDeleteId, confirmDeleteTag, creationOpen, deleteFolder,
    deleteTag, deleteWorkflow, draggingId, dropTarget, folderFilter, folderOptions, groups,
    hasActiveFilters, hasFolders, hasMore, load, loadError, loadMore, loading, loadingMore,
    moveToFolder, newFolderDraft, newFolderDropFor, newFolderHover, onCreate, onOpen,
    persistCollapsedFolders, query, searchHint, searchInvalid, recoveryBusyIds, renameDraft, renameFolder, renameTag,
    renamingFolder, renamingTag, restoreWorkflow, resumeWorkflow, selectedIds,
    selectionMode, setBulkFolderDraft, setBulkTagDraft, setConfirmDeleteFolder,
    setConfirmDeleteId, setConfirmDeleteTag, setCreationOpen, setDraggingId, setDropTarget,
    setFolderFilter, setNewFolderDraft, setNewFolderDropFor, setNewFolderHover, setQuery,
    setRenameDraft, setRenamingFolder, setRenamingTag, setSelectedIds, setSelectionMode,
    setShowTrashed, setSort, setTagFilters, setTagRenameDraft, setRowTag, showToolbar,
    showTrashed, soleTagFilter, sort, t, tagFilters, tagOptions, tagRenameDraft,
    toggleFolder, toggleSelectAll, toggleSelectFolder, toggleSelected, toggleTrashView,
    rememberFolderToggle, trashNowMs, retentionDays, visible, visibleIds, workflows,
  }
}
export type WorkflowsDashboardController = ReturnType<typeof useWorkflowsDashboardController>
export function WorkflowsDashboard(props: WorkflowsDashboardProps) {
  return <WorkflowsDashboardView model={useWorkflowsDashboardController(props)} />
}
