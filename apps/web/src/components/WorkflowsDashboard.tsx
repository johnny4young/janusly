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
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [loading, setLoading] = useState(false)
  // Tag / search / sort restore from localStorage on mount (per-browser) so the
  // Flows view survives navigation + reload; persisted by the effect below. A
  // missing / corrupt value degrades to the defaults via the helper.
  const [query, setQuery] = useState(() => readFlowsFilters()?.query ?? '')
  const [sort, setSort] = useState<SortKey>(() => readFlowsFilters()?.sort ?? 'recent')
  // Server-side tag filter (the dropdown lists ALL the org's tags + matches
  // surface beyond the list cap); '' means "All tags".
  const [tagFilter, setTagFilter] = useState(() => readFlowsFilters()?.tag ?? '')
  const [tagOptions, setTagOptions] = useState<string[]>([])
  // Collapsed folder sections (persisted per-browser). A stale entry (folder
  // renamed/deleted since) simply matches no rendered section — a harmless no-op.
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(
    () => readFlowsFilters()?.collapsedFolders ?? [],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (tagFilter) params.set('tag', tagFilter)
      const qs = params.toString()
      const data = await api(`/workflows${qs ? `?${qs}` : ''}`)
      setWorkflows(Array.isArray(data) ? data : [])
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('workflowsDashboard.toastFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast, t, tagFilter])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  // Persist the tag / search / sort / collapsed-folders view per-browser so it
  // survives navigation + reload. The initial run re-writes the restored values
  // (a harmless no-op).
  useEffect(() => {
    writeFlowsFilters({ tag: tagFilter, query, sort, collapsedFolders })
  }, [tagFilter, query, sort, collapsedFolders])

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
        // Drop a restored tag the org no longer offers (e.g. deleted since the
        // last visit) so the filter can't strand the list on an empty,
        // un-clearable view. The functional update reads the current tagFilter
        // without adding it to this effect's deps.
        setTagFilter(current => (current !== '' && !tags.includes(current) ? '' : current))
      } catch {
        if (!cancelled) setTagOptions([])
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

  // Keep the toolbar visible whenever filtering is meaningful OR a filter is
  // active — otherwise a tag filter that narrows the (server-filtered) list to
  // ≤1 row would hide the toolbar and trap the user with no way to clear it.
  const showToolbar = tagOptions.length > 0 || workflows.length > 1 || tagFilter !== '' || query.trim() !== ''

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

  const renderRow = (workflow: SavedWorkflow) => (
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
          {workflow.tags && workflow.tags.length > 0 && (
            <span className="we-list-row__tags">
              {workflow.tags.map(tag => (
                <span key={tag} className="we-pill we-pill--ghost">{tag}</span>
              ))}
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
          <button onClick={(event) => { event.stopPropagation(); onOpen(workflow.id) }} className="small-command">{t('workflowsDashboard.openFlow')}</button>
        </div>
      </div>
    </li>
  )

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
          {tagOptions.length > 0 && (
            <select
              className="text-field"
              value={tagFilter}
              onChange={event => setTagFilter(event.target.value)}
              aria-label={t('workflowsDashboard.tagFilterAria') as string}
              data-testid="workflows-tag-filter"
            >
              <option value="">{t('workflowsDashboard.allTags')}</option>
              {tagOptions.map(tag => (
                <option key={tag} value={tag}>{tag}</option>
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
        </div>
      )}

      {workflows.length === 0 && !loading && tagFilter !== '' && (
        <p className="helper-text" data-testid="workflows-no-tag-matches">
          {t('workflowsDashboard.noTagMatches', { tag: tagFilter })}
        </p>
      )}

      {workflows.length === 0 && !loading && tagFilter === '' && (
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
                open={!collapsedFolders.includes(group.key)}
                onToggle={event => toggleFolder(group.key, (event.currentTarget as HTMLDetailsElement).open)}
                data-testid={`workflows-folder-${group.key === UNGROUPED ? 'ungrouped' : group.key}`}
              >
                <summary className="we-list-folder__summary">
                  <span className="we-list-folder__name">{label}</span>
                  <span className="we-pill we-pill--ghost">{t('workflowsDashboard.folderCount', { count: group.items.length })}</span>
                </summary>
                <ul className="we-list">
                  {group.items.map(renderRow)}
                </ul>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}
