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

import { useEffect, useMemo, useRef, useState } from 'react'
import { GitCompare, History, RotateCcw, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { OrgMember, OrgRole, WorkflowDefinition } from '../types'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'
import { WorkflowDiffView } from './WorkflowDiffView'
import { EmptyState } from './EmptyState'
import { useConfirm } from './ConfirmDialog'
import { getResolvedLocale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

type VersionRow = { id: string; version: number; dagJson: WorkflowDefinition; createdAt?: string }

/**
 * Improvement suggestion as the API returns it. Mirrors the helper's
 * `SuggestImprovementItem` after the route's per-suggestion validation
 * + sanitisation pass — every workflow here is already engine-valid.
 */
type ImprovementSuggestion = {
  workflow: WorkflowDefinition
  rationale: string
  approachLabel: string
  confidence: number
}

/**
 * State machine for the "Suggest improvement" affordance. The button
 * lives in Compare mode below the diff and is only available to
 * editors / admins. Each terminal state renders a different cluster of
 * UI: idle shows just the button; loading disables it; ai mounts a
 * second `<WorkflowDiffView>` with chips to switch between angles;
 * fallback shows a ribbon with the AI error and the original workflow
 * left untouched.
 */
type ImprovementState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ai'
      suggestions: ImprovementSuggestion[]
      activeIdx: number
      baseWorkflow: WorkflowDefinition
      baseLabel: string
      model?: string
    }
  | { kind: 'fallback'; aiError: string }

/**
 * UI gate: hide the Rollback / Suggest-improvement CTAs from read-only
 * viewers. Custom roles (created via the permission-grants admin UI)
 * carry org-defined names like `compliance`; the server is the
 * authoritative gate (it consults the role's `inheritsFrom` rank and
 * effective permission set), so the web only needs to err on the side
 * of showing the CTA for any non-`viewer` non-null role and let the
 * server reject if the actual permission is missing.
 */
function canRollbackWithRole(role: string | null | undefined) {
  return typeof role === 'string' && role !== '' && role !== 'viewer'
}

/** Same role posture as Rollback — read-only viewers can't trigger AI mutation routes. */
const canSuggestWithRole = canRollbackWithRole

const APPROACH_KEYS: Record<string, string> = {
  add_retry: 'versionHistory.approach.add_retry',
  raise_timeout: 'versionHistory.approach.raise_timeout',
  swap_secret_ref: 'versionHistory.approach.swap_secret_ref',
  add_approval: 'versionHistory.approach.add_approval',
  add_observability: 'versionHistory.approach.add_observability',
  simplify: 'versionHistory.approach.simplify',
  other: 'versionHistory.approach.other',
}

function approachLabelText(label: string): string {
  const key = APPROACH_KEYS[label]
  return key ? (runtimeT(key as never) as string) : label
}

/** Render the version-history list for the active workflow with click-to-hydrate. */
export function VersionHistoryPanel() {
  const { t } = useT()
  const confirm = useConfirm()
  const currentWorkflowId = useWorkflowStore(state => state.currentWorkflowId)
  const currentWorkflowSaved = useWorkflowStore(state => state.currentWorkflowSaved)
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
  // Local state for the AI improvement-suggestion affordance. Local —
  // not Zustand — because no other panel cares about this transient
  // suggestion state, and a fetch in flight should not survive a
  // workflow switch. Cleared whenever the active workflow changes,
  // compare mode toggles, or the operator picks a different version
  // pair (see effects below).
  const [improvement, setImprovement] = useState<ImprovementState>({ kind: 'idle' })
  // Cancel flag for an in-flight `/ai/suggest-improvement` call. Each
  // of the three invalidation sites (workflow change, compare-mode
  // toggle, version-pair change) flips this to true before resetting
  // `improvement` to idle; the click handler checks it after the
  // `await` so a stale promise can't overwrite the now-cleared state
  // with a suggestion that's tied to a different baseline.
  const suggestCancelRef = useRef(false)

  useEffect(() => {
    suggestCancelRef.current = true
    setVersions([])
    setSelectedIds([])
    setCompareMode(false)
    setRollbackPair(null)
    setImprovement({ kind: 'idle' })
  }, [currentWorkflowId])

  useEffect(() => {
    let cancelled = false

    const loadVersions = async () => {
      if (!currentWorkflowId || !currentWorkflowSaved) {
        setVersions([])
        return
      }
      try {
        const data = await api(`/workflows/versions?workflowId=${encodeURIComponent(currentWorkflowId)}`)
        if (cancelled) return
        const rows = Array.isArray(data) ? (data as VersionRow[]) : []
        setVersions(rows)
        setSelectedIds((prev) => prev.filter((id) => rows.some((version) => version.id === id)))
        if (rows.length < 2) setCompareMode(false)
      } catch (error) {
        if (!cancelled) {
          addToast(error instanceof Error ? error.message : (t('versionHistory.loadFailed')), 'error')
        }
      }
    }

    void loadVersions()
    return () => {
      cancelled = true
    }
  }, [addToast, currentWorkflowId, currentWorkflowSaved, platformVersion, t])

  useEffect(() => {
    let cancelled = false

    const loadEffectiveRole = async () => {
      if (!userId) {
        // Dev-headers mode has no Supabase session AND no userId in
        // the store (App.tsx clears auth on every onAuthStateChange
        // when the dev `session` is null, which wipes the dev
        // identity). Backend role checks intentionally fall back to
        // admin in dev when no org_members row exists, so mirror that
        // here — otherwise role-gated UI (Rollback, Suggest
        // improvement) is silently hidden in dev. Production with a
        // session but a still-loading userId still resolves to null
        // here, hiding the button until userId lands.
        setEffectiveRole(!session ? 'admin' : null)
        return
      }

      try {
        const data = await api('/members')
        if (cancelled) return
        const members = Array.isArray(data) ? (data as OrgMember[]) : []
        const member = members.find((row) => row.userId === userId)
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
    void (async () => {
      // Loading an old version replaces the canvas — same unsaved-work guard
      // as the App-level hydrate paths (S-01).
      if (useWorkflowStore.getState().workflowDirty) {
        const proceed = await confirm({
          title: t('unsavedGuard.title'),
          body: t('unsavedGuard.body'),
          confirmLabel: t('unsavedGuard.discard'),
          tone: 'danger',
        })
        if (!proceed) return
      }
      hydrateWorkflow(version.dagJson)
      addToast(t('versionHistory.loaded', { version: version.version }), 'success')
    })()
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
      // Picking a fresh comparison invalidates any in-flight or
      // already-rendered improvement suggestions — they were tied to
      // a different version pair.
      suggestCancelRef.current = true
      setImprovement({ kind: 'idle' })
      return next
    })
  }

  // Drop any rendered improvement when the operator changes which two
  // versions they're comparing. The suggestions hung off the previous
  // pair's "newer" version; keeping them around would silently mismatch.
  useEffect(() => {
    suggestCancelRef.current = true
    setImprovement({ kind: 'idle' })
  }, [selectedIds])

  const onSuggestImprovement = async () => {
    if (!comparePair) return
    // Reset the cancel flag for THIS call. Subsequent invalidation
    // sites flip it back to true; we check after `await` to bail out
    // of the resolved (or rejected) promise's setState path.
    suggestCancelRef.current = false
    const newer = comparePair[1]
    setImprovement({ kind: 'loading' })
    try {
      const data = await api('/ai/suggest-improvement', {
        method: 'POST',
        body: JSON.stringify({ workflow: newer.dagJson }),
      }) as {
        mode?: 'ai' | 'fallback'
        suggestions?: ImprovementSuggestion[]
        aiError?: string
        model?: string
      }
      if (suggestCancelRef.current) return
      if (data.mode === 'ai' && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        setImprovement({
          kind: 'ai',
          suggestions: data.suggestions,
          activeIdx: 0,
          baseWorkflow: newer.dagJson,
          baseLabel: `v${newer.version}`,
          model: data.model,
        })
      } else {
        setImprovement({
          kind: 'fallback',
          aiError: data.aiError ?? (t('versionHistory.aiUnavailableDefault')),
        })
      }
    } catch (error) {
      if (suggestCancelRef.current) return
      setImprovement({
        kind: 'fallback',
        aiError: error instanceof Error ? error.message : (t('versionHistory.aiRequestFailed')),
      })
    }
  }

  const onResetImprovement = () => {
    suggestCancelRef.current = true
    setImprovement({ kind: 'idle' })
  }

  const showSuggestButton =
    compareMode &&
    Boolean(comparePair) &&
    canSuggestWithRole(effectiveRole) &&
    improvement.kind !== 'ai' &&
    improvement.kind !== 'fallback'

  return (
    <div className="we-card">
      <div className="version-history__head">
        <div className="section-kicker">
          <History size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
          {t('versionHistory.heading')}
        </div>
        {versions.length >= 2 && (
          <button
            type="button"
            className={`small-command${compareMode ? ' small-command--active' : ''}`}
            onClick={onToggleCompare}
            aria-pressed={compareMode}
          >
            <GitCompare size={12} aria-hidden="true" /> {compareMode ? t('versionHistory.cancelCompare') : t('versionHistory.compare')}
          </button>
        )}
      </div>

      {versions.length === 0 && (
        <EmptyState
          icon={<History />}
          kicker={t('versionHistory.emptyKicker')}
          body={t('versionHistory.empty')}
          testId="version-history-empty"
        />
      )}

      {versions.map((version, index) => {
        const isSelected = selectedIds.includes(version.id)
        const isLatest = index === 0
        // Rolling back to the latest version is a no-op; in compare-mode the
        // row's checkbox owns the click. Hide the Rollback button in both
        // cases. With only one version there's nothing to roll back to.
        const showRollback = canRollbackWithRole(effectiveRole) && !compareMode && versions.length > 1 && index !== 0
        return (
          <div
            key={version.id}
            className="version-row"
            data-latest={isLatest ? 'true' : undefined}
            data-selected={compareMode && isSelected ? 'true' : undefined}
          >
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
              {isLatest && <span className="we-list-row__pill we-list-row__pill--cobalt">{t('versionHistory.latest')}</span>}
              <span>{version.createdAt ? new Date(version.createdAt).toLocaleString(getResolvedLocale()) : ''}</span>
            </button>
            {showRollback && versions[0] && (
              <button
                type="button"
                className="version-row__rollback"
                onClick={() => setRollbackPair({ currentId: versions[0]!.id, targetId: version.id })}
                aria-label={t('versionHistory.rollbackAria', { version: version.version })}
                title={t('versionHistory.rollbackAria', { version: version.version })}
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
          {t('versionHistory.pickPair')}
        </p>
      )}

      {showSuggestButton && (
        <div className="we-suggest-actions">
          <button
            type="button"
            className="small-command"
            onClick={onSuggestImprovement}
            disabled={improvement.kind === 'loading'}
          >
            <Sparkles size={12} aria-hidden="true" />{' '}
            {improvement.kind === 'loading' ? t('versionHistory.generating') : t('versionHistory.suggest')}
          </button>
          <p className="helper-text we-suggest-hint">
            {t('versionHistory.suggestHint', { version: comparePair![1].version })}
          </p>
        </div>
      )}

      {improvement.kind === 'ai' && comparePair && improvement.suggestions[improvement.activeIdx] && (() => {
        const active = improvement.suggestions[improvement.activeIdx]!
        return (
          <div className="we-suggest-result" aria-label={t('versionHistory.aiSuggestionsAria')}>
            <div className="we-suggest-header">
              <span className="section-kicker">
                <Sparkles size={11} aria-hidden="true" style={{ marginRight: 4, verticalAlign: '-1px' }} />
                {t('versionHistory.aiHeader', { baseLabel: improvement.baseLabel })}
              </span>
              <button
                type="button"
                className="we-suggest-close"
                onClick={onResetImprovement}
                aria-label={t('versionHistory.dismissAi')}
                title={t('versionHistory.dismissShort')}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
            {improvement.suggestions.length > 1 && (
              <div className="we-suggest-chips" role="tablist" aria-label={t('versionHistory.anglesAria')}>
                {improvement.suggestions.map((suggestion, idx) => (
                  <button
                    key={`${suggestion.approachLabel}:${idx}`}
                    type="button"
                    role="tab"
                    aria-selected={idx === improvement.activeIdx}
                    className={`we-suggest-chip${idx === improvement.activeIdx ? ' we-suggest-chip--active' : ''}`}
                    onClick={() => setImprovement({ ...improvement, activeIdx: idx })}
                  >
                    {approachLabelText(suggestion.approachLabel)} · {suggestion.confidence}%
                  </button>
                ))}
              </div>
            )}
            <WorkflowDiffView
              before={improvement.baseWorkflow}
              after={active.workflow}
              beforeLabel={improvement.baseLabel}
              afterLabel={t('versionHistory.suggested', { approach: approachLabelText(active.approachLabel) })}
              aiPatchRationale={active.rationale}
            />
          </div>
        )
      })()}

      {improvement.kind === 'fallback' && (
        <div className="we-suggest-fallback" role="status" aria-live="polite">
          <span className="we-suggest-fallback__title">{t('versionHistory.aiUnavailable')}</span>
          <span className="we-suggest-fallback__detail">{improvement.aiError}</span>
          <button
            type="button"
            className="we-suggest-fallback__close"
            onClick={onResetImprovement}
            aria-label={t('versionHistory.dismissFallback')}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
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
