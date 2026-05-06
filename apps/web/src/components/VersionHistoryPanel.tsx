/**
 * Workflow version history list. Re-fetches whenever `platformVersion`
 * changes (the cross-panel reactivity hook from AGENTS.md). Two modes:
 *
 *   - **Default**: clicking a version row hydrates the canvas with that
 *     DAG. Same behaviour the panel always had.
 *   - **Compare**: toggled via the "Compare" button. Each row gets a
 *     checkbox; picking two rows expands a `<WorkflowDiffView>` panel
 *     inline below the list. Older version is rendered on the left
 *     regardless of click order.
 *
 * Used by `RightPanel.tsx` (Inspector tab → version history).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { GitCompare, History, RotateCcw } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole, WorkflowDefinition } from '../types'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'
import { WorkflowDiffView } from './WorkflowDiffView'

type VersionRow = { id: string; version: number; dagJson: WorkflowDefinition; createdAt?: string }

function canRollbackWithRole(role: OrgRole | null) {
  return role === 'editor' || role === 'admin'
}

/** Render the version-history list for the active workflow with click-to-hydrate. */
export function VersionHistoryPanel() {
  const currentWorkflowId = useWorkflowStore(state => state.currentWorkflowId)
  const session = useWorkflowStore(state => state.session)
  const userId = useWorkflowStore(state => state.userId)
  const orgId = useWorkflowStore(state => state.orgId)
  const hydrateWorkflow = useWorkflowStore(state => state.hydrateWorkflow)
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [effectiveRole, setEffectiveRole] = useState<OrgRole | null>(null)
  const [compareMode, setCompareMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Snapshot the (current, target) ids at the moment the operator clicks
  // Rollback. We don't read `versions[0]` at dialog-render time because a
  // sibling save bumping `platformVersion` between open and close would
  // shift "current" to a newer version under the operator — the diff
  // they're looking at would silently change.
  const [rollbackPair, setRollbackPair] = useState<{ currentId: string; targetId: string } | null>(null)

  useEffect(() => {
    setVersions([])
    setSelectedIds([])
    setCompareMode(false)
    setRollbackPair(null)
  }, [currentWorkflowId])

  useEffect(() => {
    let cancelled = false

    const loadVersions = async () => {
      if (!currentWorkflowId) return
      try {
        const data = await api(`/workflows/versions?workflowId=${encodeURIComponent(currentWorkflowId)}`)
        if (cancelled) return
        const rows = Array.isArray(data) ? (data as VersionRow[]) : []
        setVersions(rows)
        setSelectedIds((prev) => prev.filter((id) => rows.some((version) => version.id === id)))
        if (rows.length < 2) setCompareMode(false)
      } catch (error) {
        if (!cancelled) {
          addToast(error instanceof Error ? error.message : 'Version history failed to load', 'error')
        }
      }
    }

    void loadVersions()
    return () => {
      cancelled = true
    }
  }, [addToast, currentWorkflowId, platformVersion])

  useEffect(() => {
    let cancelled = false

    const loadEffectiveRole = async () => {
      if (!userId) {
        setEffectiveRole(null)
        return
      }

      try {
        const data = await api('/members')
        if (cancelled) return
        const members = Array.isArray(data) ? (data as OrgMember[]) : []
        const member = members.find((row) => row.userId === userId)
        // Dev-headers mode has no Supabase session. Backend role checks
        // intentionally fall back to admin only when no org_members row
        // exists, so mirror that here to avoid hiding editor-only UI in
        // fresh local checkouts.
        setEffectiveRole(member?.role ?? (!session ? 'admin' : null))
      } catch {
        if (!cancelled) setEffectiveRole(null)
      }
    }

    void loadEffectiveRole()
    return () => {
      cancelled = true
    }
  }, [orgId, platformVersion, session, userId])

  // Resolve the two selected rows; sort by version asc so the older one
  // is always on the left regardless of click order.
  const comparePair = useMemo(() => {
    if (selectedIds.length !== 2) return null
    const rows = selectedIds
      .map((id) => versions.find((v) => v.id === id))
      .filter((row): row is VersionRow => Boolean(row))
    if (rows.length !== 2) return null
    return [...rows].sort((a, b) => a.version - b.version) as [VersionRow, VersionRow]
  }, [selectedIds, versions])

  const onRowClick = (version: VersionRow) => {
    if (compareMode) {
      toggleSelected(version.id)
      return
    }
    hydrateWorkflow(version.dagJson)
    addToast(`Loaded v${version.version}`, 'success')
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((existing) => existing !== id)
      // Cap at 2 — drop the oldest selection so the operator's most recent
      // two clicks are the ones that count.
      const next = [...prev, id]
      return next.length <= 2 ? next : next.slice(-2)
    })
  }

  const onToggleCompare = () => {
    setCompareMode((prev) => {
      const next = !prev
      if (!next) setSelectedIds([])
      return next
    })
  }

  return (
    <div className="panel-card">
      <div className="version-history__head">
        <div className="section-kicker">
          <History size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
          Version History
        </div>
        {versions.length >= 2 && (
          <button
            type="button"
            className={`small-command${compareMode ? ' small-command--active' : ''}`}
            onClick={onToggleCompare}
            aria-pressed={compareMode}
          >
            <GitCompare size={12} aria-hidden="true" /> {compareMode ? 'Cancel' : 'Compare'}
          </button>
        )}
      </div>

      {versions.length === 0 && <p className="empty-state">Save a workflow to start tracking versions.</p>}

      {versions.map((version, index) => {
        const isSelected = selectedIds.includes(version.id)
        // Rolling back to the latest version is a no-op; in compare-mode the
        // row's checkbox owns the click. Hide the Rollback button in both
        // cases. With only one version there's nothing to roll back to.
        const showRollback = canRollbackWithRole(effectiveRole) && !compareMode && versions.length > 1 && index !== 0
        return (
          <div key={version.id} className="version-row">
            <button
              type="button"
              onClick={() => onRowClick(version)}
              className={`version-button${compareMode && isSelected ? ' version-button--selected' : ''}`}
              aria-pressed={compareMode ? isSelected : undefined}
            >
              {compareMode && (
                <span className={`version-button__check${isSelected ? ' version-button__check--on' : ''}`} aria-hidden="true">
                  {isSelected ? '✓' : ''}
                </span>
              )}
              <span>v{version.version}</span>
              <span>{version.createdAt ? new Date(version.createdAt).toLocaleString() : ''}</span>
            </button>
            {showRollback && versions[0] && (
              <button
                type="button"
                className="version-row__rollback"
                onClick={() => setRollbackPair({ currentId: versions[0]!.id, targetId: version.id })}
                aria-label={`Roll back to v${version.version}`}
                title={`Roll back to v${version.version}`}
              >
                <RotateCcw size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}

      {compareMode && comparePair && (
        <WorkflowDiffView
          before={comparePair[0].dagJson}
          after={comparePair[1].dagJson}
          beforeLabel={`v${comparePair[0].version}`}
          afterLabel={`v${comparePair[1].version}`}
        />
      )}

      {compareMode && !comparePair && (
        <p className="helper-text" aria-live="polite">
          Pick two versions to see the diff.
        </p>
      )}

      {rollbackPair && (() => {
        const current = versions.find((row) => row.id === rollbackPair.currentId)
        const target = versions.find((row) => row.id === rollbackPair.targetId)
        // If either snapshot row dropped out (e.g. a deletion / refetch
        // race) the dialog can't render meaningfully — close it.
        if (!current || !target) return null
        return (
          <RollbackConfirmDialog
            workflowId={currentWorkflowId}
            current={current}
            target={target}
            onClose={() => setRollbackPair(null)}
          />
        )
      })()}
    </div>
  )
}
