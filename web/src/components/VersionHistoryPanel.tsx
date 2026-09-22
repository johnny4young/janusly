/**
 * Workflow version history list. Resource invalidation refreshes the owned
 * history snapshot. Two modes:
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitCompare, History, RotateCcw, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { readWorkflowVersionPage, type WorkflowVersionRow } from '../lib/list-contract'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'
import { WorkflowDiffView } from './WorkflowDiffView'
import { EmptyState } from './EmptyState'
import { useConfirm } from './ConfirmDialog'
import { getResolvedLocale, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { sessionCan } from '../identity-context'
import './VersionHistoryPanel.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { Button } from './ui/Button'

const VERSION_HISTORY_TAGS = [PLATFORM_TAG, 'workflows', 'versions', 'rollouts'] as const

type VersionRow = WorkflowVersionRow

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

function improvementConfidencePercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(1, Math.max(0, value)) * 100)
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
      base: VersionRow
    }
  | { kind: 'fallback'; aiError: string }

// The history is a keyset page, newest first; the next page starts below
// the oldest version already shown.
const VERSIONS_PAGE_SIZE = 50

const APPROACHES = ['add_retry', 'raise_timeout', 'swap_secret_ref', 'add_approval', 'add_observability', 'simplify', 'other']

function approachLabelText(label: string): string {
  return APPROACHES.includes(label) ? runtimeT(`versionHistory.approach.${label}`) : label
}

/** Render the version-history list for the active workflow with click-to-hydrate. */
export function VersionHistoryPanel() {
  const scope = useWorkflowStore(historyScope)
  return <ScopedVersionHistory key={scope} scope={scope} />
}

function historyScope(state: ReturnType<typeof useWorkflowStore.getState>): string {
  return JSON.stringify([state.orgId, state.userId, state.currentWorkflowId, state.currentWorkflowSaved,
    sessionCan(state.identityContext, 'workflows.write'), sessionCan(state.identityContext, 'ai.write')])
}

function ScopedVersionHistory({ scope }: { scope: string }) {
  const { t } = useT()
  const confirm = useConfirm()
  // The keyed wrapper subscribes to every contextual value used here.
  const { currentWorkflowId, currentWorkflowSaved, identityContext, hydrateWorkflow, addToast } = useWorkflowStore.getState()
  const platformVersion = useInvalidationNonce(VERSION_HISTORY_TAGS)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [hasMoreVersions, setHasMoreVersions] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Snapshot the (current, target) ids at the moment the operator clicks
  // Rollback. We don't read `versions[0]` at dialog-render time because a
  // sibling save bumping `platformVersion` between open and close would
  // shift "current" to a newer version under the operator — the diff
  // they're looking at would silently change.
  const [rollbackPair, setRollbackPair] = useState<{ currentId: string; targetId: string } | null>(null)
  const [improvement, setImprovement] = useState<ImprovementState>({ kind: 'idle' })
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const owner = useRef<AbortController | null>(null)
  const suggestion = useRef<AbortController | null>(null)
  const current = useCallback((request: AbortController | null): request is AbortController =>
    request !== null && !request.signal.aborted && historyScope(useWorkflowStore.getState()) === scope, [scope])

  useEffect(() => {
    const request = new AbortController()
    owner.current = request
    setVersions([])
    setHasMoreVersions(false)
    setLoadingMore(false)
    setRollbackPair(null)
    setImprovement({ kind: 'idle' })
    setLoadState('loading')
    const loadVersions = async () => {
      if (!currentWorkflowId || !currentWorkflowSaved) {
        setLoadState('ready')
        return
      }
      try {
        const rows = await readWorkflowVersionPage(currentWorkflowId, { limit: VERSIONS_PAGE_SIZE }, request.signal)
        if (!current(request)) return
        setVersions(rows)
        setLoadState('ready')
        setHasMoreVersions(rows.length >= VERSIONS_PAGE_SIZE)
        setSelectedIds(prev => prev.filter(id => rows.some(version => version.id === id)))
        if (rows.length < 2) setCompareMode(false)
      } catch (error) {
        if (!current(request)) return
        setLoadState('error')
        addToast(error instanceof Error ? error.message : t('versionHistory.loadFailed'), 'error')
      }
    }
    void loadVersions()
    return () => {
      request.abort()
      suggestion.current?.abort()
    }
  }, [addToast, current, currentWorkflowId, currentWorkflowSaved, platformVersion, retry, t])

  const canRollback = sessionCan(identityContext, 'workflows.write')
  const canSuggest = sessionCan(identityContext, 'ai.write')

  // Resolve the two selected rows; sort by version asc so the older one
  // is always on the left regardless of click order.
  const [left, right] = selectedIds.map(id => versions.find(version => version.id === id))
  const comparePair = left && right
    ? (left.version < right.version ? [left, right] as const : [right, left] as const)
    : null

  const onRowClick = (version: VersionRow) => {
    if (compareMode) {
      toggleSelected(version.id)
      return
    }
    const request = owner.current
    const revision = useWorkflowStore.getState().workflowRevision
    if (!current(request)) return
    void (async () => {
      // Loading an old version replaces the canvas — same unsaved-work guard
      // as the App-level hydrate paths.
      if (useWorkflowStore.getState().workflowDirty) {
        const proceed = await confirm({
          title: t('unsavedGuard.title'),
          body: t('unsavedGuard.body'),
          confirmLabel: t('unsavedGuard.discard'),
          tone: 'danger',
        })
        if (!proceed) return
      }
      if (!current(request) || useWorkflowStore.getState().workflowRevision !== revision) return
      hydrateWorkflow({ ...version.dagJson, id: currentWorkflowId }, { version: { id: version.id, version: version.version } })
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

  const onLoadMoreVersions = async () => {
    const request = owner.current
    if (!current(request) || !currentWorkflowId || loadingMore || versions.length === 0) return
    const oldest = versions[versions.length - 1].version
    setLoadingMore(true)
    try {
      const rows = await readWorkflowVersionPage(currentWorkflowId, { limit: VERSIONS_PAGE_SIZE, beforeVersion: oldest }, request.signal)
      if (!current(request)) return
      setVersions((prev) => [...prev, ...rows.filter((row) => !prev.some((known) => known.id === row.id))])
      setHasMoreVersions(rows.length >= VERSIONS_PAGE_SIZE)
    } catch (error) {
      if (current(request)) addToast(error instanceof Error ? error.message : t('versionHistory.loadFailed'), 'error')
    } finally {
      if (current(request)) setLoadingMore(false)
    }
  }

  const onResetImprovement = () => {
    suggestion.current?.abort()
    setImprovement({ kind: 'idle' })
  }

  const onToggleCompare = () => {
    onResetImprovement()
    if (compareMode) setSelectedIds([])
    setCompareMode(!compareMode)
  }

  useEffect(() => {
    suggestion.current?.abort()
    setImprovement({ kind: 'idle' })
  }, [selectedIds])

  const onSuggestImprovement = async () => {
    const history = owner.current
    if (!current(history) || !canSuggest || !comparePair || improvement.kind === 'loading') return
    suggestion.current?.abort()
    const request = new AbortController()
    suggestion.current = request
    const newer = comparePair[1]
    setImprovement({ kind: 'loading' })
    try {
      const data = await api('/ai/suggest-improvement', {
        method: 'POST', signal: request.signal,
        body: JSON.stringify({ workflow: newer.dagJson }),
      }) as {
        mode?: 'ai' | 'fallback'
        suggestions?: ImprovementSuggestion[]
        aiError?: string
        }
      if (!current(history) || request.signal.aborted) return
      if (data.mode === 'ai' && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        setImprovement({
          kind: 'ai',
          suggestions: data.suggestions,
          activeIdx: 0,
          base: newer,
        })
      } else {
        setImprovement({
          kind: 'fallback',
          aiError: data.aiError ?? (t('versionHistory.aiUnavailableDefault')),
        })
      }
    } catch (error) {
      if (!current(history) || request.signal.aborted) return
      setImprovement({
        kind: 'fallback',
        aiError: error instanceof Error ? error.message : (t('versionHistory.aiRequestFailed')),
      })
    }
  }

  const showSuggestButton =
    compareMode &&
    Boolean(comparePair) &&
    canSuggest &&
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
          <Button
            size="sm"
            aria-pressed={compareMode}
            onClick={onToggleCompare}
            leadingIcon={<GitCompare size={12} />}
          >
            {compareMode ? t('versionHistory.cancelCompare') : t('versionHistory.compare')}
          </Button>
        )}
      </div>

      {loadState === 'loading' && <p role="status">{t('common.loading')}</p>}
      {loadState === 'error' && <div role="alert"><p>{t('versionHistory.loadFailed')}</p>
        <Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>}
      {loadState === 'ready' && versions.length === 0 && (
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
        const showRollback = canRollback && !compareMode && versions.length > 1 && index !== 0
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
              <Button size="icon" variant="ghost"
                className="version-row__rollback"
                onClick={() => setRollbackPair({ currentId: versions[0]!.id, targetId: version.id })}
                aria-label={t('versionHistory.rollbackAria', { version: version.version })}
                title={t('versionHistory.rollbackAria', { version: version.version })}
              >
                <RotateCcw size={12} aria-hidden="true" />
              </Button>
            )}
          </div>
        )
      })}
      {hasMoreVersions && (
        <Button
          size="sm"
          onClick={onLoadMoreVersions}
          disabled={loadingMore}
          data-testid="version-history-load-more"
        >
          {t('versionHistory.loadMore')}
        </Button>
      )}

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
          <Button
            size="sm"
            onClick={onSuggestImprovement}
            disabled={improvement.kind === 'loading'}
          >
            <Sparkles size={12} aria-hidden="true" />{' '}
            {improvement.kind === 'loading' ? t('versionHistory.generating') : t('versionHistory.suggest')}
          </Button>
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
                {t('versionHistory.aiHeader', { baseLabel: `v${improvement.base.version}` })}
              </span>
              <Button size="icon" variant="ghost"
                onClick={onResetImprovement}
                aria-label={t('versionHistory.dismissAi')}
                title={t('versionHistory.dismissShort')}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            </div>
            {improvement.suggestions.length > 1 && (
              <div className="we-suggest-chips" role="group" aria-label={t('versionHistory.anglesAria')}>
                {improvement.suggestions.map((suggestion, idx) => (
                  <Button size="sm"
                    key={`${suggestion.approachLabel}:${idx}`}
                    aria-pressed={idx === improvement.activeIdx}
                    onClick={() => setImprovement({ ...improvement, activeIdx: idx })}
                  >
                    {approachLabelText(suggestion.approachLabel)} · {improvementConfidencePercent(suggestion.confidence)}%
                  </Button>
                ))}
              </div>
            )}
            <WorkflowDiffView
              before={improvement.base.dagJson}
              after={active.workflow}
              beforeLabel={`v${improvement.base.version}`}
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
          <Button size="icon" variant="ghost"
            className="we-suggest-fallback__close"
            onClick={onResetImprovement}
            aria-label={t('versionHistory.dismissFallback')}
          >
            <X size={12} aria-hidden="true" />
          </Button>
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
