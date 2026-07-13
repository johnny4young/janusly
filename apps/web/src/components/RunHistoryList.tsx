/**
 * Bounded run-history browser. Owns server-side workflow/status filters,
 * virtualized history rows, row-level export/Lab/report actions, and the
 * historical “compare with last successful” entry point.
 *
 * Used by:
 * - `RunsPanel.tsx` below the active-run operational cards.
 *
 * Invariants:
 * - Filtered reads always use the bounded `/runs` endpoint; no client-side
 *   scan pretends the shell's first page is the org's complete history.
 * - A filter change resets virtual scroll, while platform refreshes do not.
 */

import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, Download, FilterX, FlaskConical, GitCompareArrows, RefreshCcw, Send } from 'lucide-react'
import { isTerminalRunStatus, runStatusValues, type RunStatus } from '@janusly/shared/src/status'
import { api, downloadFromApi } from '../api'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'
import { useVirtualList } from '../hooks/useVirtualList'
import { useWorkflowStore } from '../store'
import type { RunSummary, SavedWorkflow } from '../types'
import { EmptyView } from './panel-primitives'
import { RunHistoryComparisonDialog } from './RunHistoryComparisonDialog'

/** Fixed card pitch for the compact row plus its 8px bottom margin. */
const RUN_HISTORY_ROW_HEIGHT = 156

type RemoteHistoryState =
  | { key: string; kind: 'loading'; runs: [] }
  | { key: string; kind: 'ready'; runs: RunSummary[] }
  | { key: string; kind: 'error'; runs: [] }

type ComparableRun = RunSummary & { workflowId: string; createdAt: string }

function isRunStatus(value: string): value is RunStatus {
  return runStatusValues.some(status => status === value)
}

function isComparableFailure(run: RunSummary): run is ComparableRun {
  return Boolean(
    run.workflowId
    && run.createdAt
    && run.status !== 'succeeded'
    && isTerminalRunStatus(run.status),
  )
}

/** Render and filter the bounded run-history list. */
export function RunHistoryList({
  runs,
  workflows,
  onOpenRun,
  onOpenLab,
  onSend,
}: {
  runs: RunSummary[]
  workflows: SavedWorkflow[]
  onOpenRun: (runId: string) => void
  onOpenLab: (run: RunSummary) => void
  onSend: (run: RunSummary) => void
}) {
  const { t, i18n } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const [workflowId, setWorkflowId] = useState('')
  const [status, setStatus] = useState<RunStatus | ''>('')
  const [retryNonce, setRetryNonce] = useState(0)
  const [remote, setRemote] = useState<RemoteHistoryState>({ key: '', kind: 'loading', runs: [] })
  const [comparisonRun, setComparisonRun] = useState<ComparableRun | null>(null)
  const filterKey = `${workflowId}|${status}`
  const hasActiveFilters = Boolean(workflowId || status)

  useEffect(() => {
    if (!hasActiveFilters) return
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (workflowId) params.set('workflowId', workflowId)
    if (status) params.set('status', status)
    setRemote({ key: filterKey, kind: 'loading', runs: [] })

    api(`/runs?${params.toString()}`, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return
        setRemote({
          key: filterKey,
          kind: 'ready',
          runs: Array.isArray(value) ? value as RunSummary[] : [],
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setRemote({ key: filterKey, kind: 'error', runs: [] })
      })

    return () => controller.abort()
  }, [filterKey, hasActiveFilters, platformVersion, retryNonce, status, workflowId])

  const remoteForCurrentFilter = remote.key === filterKey ? remote : null
  const loading = hasActiveFilters && (!remoteForCurrentFilter || remoteForCurrentFilter.kind === 'loading')
  const failed = hasActiveFilters && remoteForCurrentFilter?.kind === 'error'
  const historyRuns = hasActiveFilters && remoteForCurrentFilter?.kind === 'ready'
    ? remoteForCurrentFilter.runs
    : hasActiveFilters ? [] : runs

  const workflowOptions = useMemo(() => {
    const labels = new Map<string, string>()
    for (const workflow of workflows) labels.set(workflow.id, workflow.name)
    for (const run of runs) {
      if (run.workflowId && !labels.has(run.workflowId)) labels.set(run.workflowId, run.workflowName || run.workflowId)
    }
    return [...labels].map(([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name, getResolvedLocale()),
    )
  }, [i18n.language, runs, workflows])
  const workflowLabels = useMemo(
    () => new Map(workflowOptions.map(option => [option.id, option.name])),
    [workflowOptions],
  )

  const {
    containerRef,
    visibleItems,
    totalHeight,
    startOffset,
  } = useVirtualList({
    items: historyRuns,
    rowHeight: RUN_HISTORY_ROW_HEIGHT,
    resetScrollKey: filterKey,
  })

  const clearFilters = () => {
    setWorkflowId('')
    setStatus('')
  }

  return (
    <div className="panel-list we-run-history" data-testid="run-history">
      <div className="split-row we-run-history__heading">
        <div>
          <div className="section-kicker">{t('rightPanel.runs.historyKicker')}</div>
          <p className="helper-text">{t('rightPanel.runs.historyDescription')}</p>
        </div>
        <span className="we-run-history__count" aria-live="polite" data-testid="run-history-count">
          {!loading && !failed ? t('rightPanel.runs.historyCount', { count: historyRuns.length }) : null}
        </span>
      </div>

      <div className="we-run-history-filters" role="group" aria-label={t('rightPanel.runs.filtersAria') as string}>
        <label>
          <span>{t('rightPanel.runs.workflowFilter')}</span>
          <select
            className="text-field"
            value={workflowId}
            onChange={event => setWorkflowId(event.target.value)}
            data-testid="run-history-workflow-filter"
          >
            <option value="">{t('rightPanel.runs.workflowFilterAll')}</option>
            {workflowOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t('rightPanel.runs.statusFilter')}</span>
          <select
            className="text-field"
            value={status}
            onChange={event => setStatus(isRunStatus(event.target.value) ? event.target.value : '')}
            data-testid="run-history-status-filter"
          >
            <option value="">{t('rightPanel.runs.statusFilterAll')}</option>
            {runStatusValues.map(value => <option key={value} value={value}>{formatStatusLabel(value)}</option>)}
          </select>
        </label>
        {hasActiveFilters && (
          <button type="button" className="small-command" onClick={clearFilters} data-testid="run-history-clear-filters">
            <FilterX size={12} aria-hidden="true" /> {t('rightPanel.runs.clearFilters')}
          </button>
        )}
      </div>

      {loading && (
        <div className="we-run-history-state" role="status">
          <RefreshCcw size={15} aria-hidden="true" /> {t('rightPanel.runs.historyLoading')}
        </div>
      )}
      {failed && (
        <div className="we-run-history-state we-run-history-state--error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{t('rightPanel.runs.historyLoadError')}</span>
          <button type="button" className="small-command" onClick={() => setRetryNonce(value => value + 1)}>
            <RefreshCcw size={12} aria-hidden="true" /> {t('rightPanel.runs.historyRetry')}
          </button>
        </div>
      )}
      {!loading && !failed && historyRuns.length === 0 && (
        <EmptyView
          icon={hasActiveFilters ? <FilterX size={22} /> : <Activity size={22} />}
          title={t(hasActiveFilters ? 'rightPanel.runs.historyNoMatches.title' : 'rightPanel.runs.historyEmpty.title') as string}
          body={t(hasActiveFilters ? 'rightPanel.runs.historyNoMatches.body' : 'rightPanel.runs.historyEmpty.body') as string}
          cta={hasActiveFilters ? {
            label: t('rightPanel.runs.clearFilters') as string,
            onClick: clearFilters,
          } : undefined}
        />
      )}
      <div
        ref={containerRef}
        className="we-virtual-list"
        data-testid="runs-history-virtual-list"
        aria-label={t('rightPanel.runs.historyListAria') as string}
        aria-busy={loading || undefined}
        hidden={loading || failed || historyRuns.length === 0}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${startOffset}px)` }}>
            {visibleItems.map(({ item: run }) => {
                const showLabAction = !run.replayMode && isTerminalRunStatus(run.status)
                const workflowLabel = run.workflowId
                  ? workflowLabels.get(run.workflowId) ?? run.workflowName ?? run.workflowId
                  : t('rightPanel.runs.unknownWorkflow') as string
                return (
                  <article key={run.id} className="list-card we-run-history-card" aria-label={t('rightPanel.runs.historyRowAria', { id: run.id }) as string}>
                    <button
                      type="button"
                      className="list-card-row"
                      onClick={() => onOpenRun(run.id)}
                      aria-label={t('rightPanel.runs.openTimelineAria', { id: run.id }) as string}
                    >
                      <div className="split-row" style={{ width: '100%' }}>
                        <strong title={workflowLabel}>{workflowLabel}</strong>
                        <span className="status-pill" data-status={run.status}>{formatStatusLabel(run.status)}</span>
                      </div>
                      <span className="we-run-history-card__identity">
                        <code>{run.id.slice(0, 8)}…</code>
                        <span>{run.createdAt ? new Date(run.createdAt).toLocaleString(getResolvedLocale()) : (t('rightPanel.runs.runFallback') as string)}</span>
                      </span>
                      <span className="list-card-action">{t('rightPanel.runs.openTimeline')}</span>
                    </button>
                    <div className="we-run-history-card__actions">
                      {isComparableFailure(run) && (
                        <button
                          type="button"
                          className="small-command small-command--primary"
                          onClick={() => setComparisonRun(run)}
                          data-testid={`history-compare-last-successful-${run.id}`}
                          aria-label={t('rightPanel.runs.compareLastSuccessfulAria', { id: run.id }) as string}
                        >
                          <GitCompareArrows size={12} aria-hidden="true" /> {t('rightPanel.runs.compareLastSuccessful')}
                        </button>
                      )}
                      {showLabAction && (
                        <button
                          type="button"
                          className="small-command"
                          onClick={() => onOpenLab(run)}
                          data-testid={`history-replay-in-lab-${run.id}`}
                          aria-label={t('rightPanel.runs.replayInLabAria', { id: run.id }) as string}
                        >
                          <FlaskConical size={12} aria-hidden="true" /> {t('rightPanel.runs.lab')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="small-command"
                        onClick={async () => {
                          try {
                            await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(run.id)}`)
                            addToast(t('rightPanel.runs.exportSuccess') as string, 'success')
                          } catch (error) {
                            addToast(error instanceof Error ? error.message : t('rightPanel.runs.exportFailed') as string, 'error')
                          }
                        }}
                        data-testid={`history-export-${run.id}`}
                        aria-label={t('rightPanel.runs.exportAria', { id: run.id }) as string}
                      >
                        <Download size={12} aria-hidden="true" /> {t('rightPanel.runs.export')}
                      </button>
                      <button
                        type="button"
                        className="small-command"
                        onClick={() => onSend(run)}
                        data-testid={`history-send-${run.id}`}
                        aria-label={t('rightPanel.runs.sendAria', { id: run.id }) as string}
                      >
                        <Send size={12} aria-hidden="true" /> {t('rightPanel.runs.send')}
                      </button>
                    </div>
                  </article>
                )
            })}
          </div>
        </div>
      </div>

      {comparisonRun && (
        <RunHistoryComparisonDialog
          selectedRun={comparisonRun}
          workflowLabel={workflowLabels.get(comparisonRun.workflowId) ?? comparisonRun.workflowName ?? comparisonRun.workflowId}
          onClose={() => setComparisonRun(null)}
        />
      )}
    </div>
  )
}
